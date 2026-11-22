use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

pub struct OriginPolicy {
    allowed: Vec<String>,
}

impl OriginPolicy {
    pub fn parse(origins: &str) -> Result<Self, String> {
        let mut allowed = Vec::new();
        for value in origins.split(',').map(str::trim) {
            let url = reqwest::Url::parse(value).map_err(|_| {
                "Allowed origins must be comma-separated HTTP(S) origins".to_string()
            })?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
                || url.origin().ascii_serialization() != value
            {
                return Err("Allowed origins must be exact HTTP(S) origins without paths, credentials, or wildcards".to_string());
            }
            allowed.push(value.to_owned());
        }
        Ok(Self { allowed })
    }

    pub fn from_env() -> Result<Self, String> {
        let origins = match std::env::var("CHINESE_READER_ALLOWED_ORIGINS") {
            Ok(value) => value,
            Err(std::env::VarError::NotPresent) => {
                "http://localhost:3000,http://127.0.0.1:3000".to_owned()
            }
            Err(_) => return Err("CHINESE_READER_ALLOWED_ORIGINS is not valid UTF-8".to_string()),
        };
        Self::parse(&origins)
    }
}

pub async fn protect_api(
    State(policy): State<std::sync::Arc<OriginPolicy>>,
    request: Request,
    next: Next,
) -> Response {
    if request.uri().path().starts_with("/api/") {
        // Host and forwarded headers are not trust signals. The reverse proxy
        // preserves Origin; both LAN and Serve URLs are configured explicitly.
        let origins: Vec<_> = request.headers().get_all(header::ORIGIN).iter().collect();
        if !origins.is_empty()
            && (origins.len() != 1
                || !origins[0]
                    .to_str()
                    .is_ok_and(|origin| policy.allowed.iter().any(|allowed| allowed == origin)))
        {
            return (StatusCode::FORBIDDEN, "Untrusted request origin").into_response();
        }
        let sites: Vec<_> = request.headers().get_all("sec-fetch-site").iter().collect();
        if !sites.is_empty()
            && (sites.len() != 1
                || !sites[0]
                    .to_str()
                    .is_ok_and(|site| matches!(site, "same-origin" | "none")))
        {
            return (
                StatusCode::FORBIDDEN,
                "Cross-site API requests are not allowed",
            )
                .into_response();
        }
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::{header, StatusCode},
        middleware,
        routing::{get, post},
        Json, Router,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    // Removing the guard or accepting a hostile header must allow the handler
    // to run and fail these tests. Use real HTTP requests and observable writes.
    #[tokio::test]
    async fn api_rejects_untrusted_requests_before_handler_side_effects() {
        let writes = Arc::new(AtomicUsize::new(0));
        let counter = writes.clone();
        let app = Router::new()
            .route(
                "/api/write",
                post(move |Json(_): Json<serde_json::Value>| {
                    let counter = counter.clone();
                    async move {
                        counter.fetch_add(1, Ordering::SeqCst);
                        StatusCode::OK
                    }
                }),
            )
            .route("/api/read", get(|| async { "private data" }))
            .route("/", get(|| async { "app shell" }))
            .layer(middleware::from_fn_with_state(
                Arc::new(
                    OriginPolicy::parse(
                        "https://chasmfiend.local,https://chasmfiend.tail56ddb.ts.net:9443",
                    )
                    .unwrap(),
                ),
                protect_api,
            ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        for origin in [
            "https://evil.example",
            "null",
            "https://chasmfiend.local.evil.example",
            "http://chasmfiend.local",
            "https://chasmfiend.local:9443",
        ] {
            let response = client
                .post(format!("{base}/api/write"))
                .header(header::ORIGIN, origin)
                .json(&serde_json::json!({}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{origin}");
            assert!(!response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        }
        let duplicate = client
            .post(format!("{base}/api/write"))
            .header(header::ORIGIN, "https://chasmfiend.local")
            .header(header::ORIGIN, "https://evil.example")
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::FORBIDDEN);
        let forged_host = client
            .post(format!("{base}/api/write"))
            .header(header::HOST, "evil.example")
            .header("x-forwarded-host", "chasmfiend.local")
            .header(header::ORIGIN, "https://evil.example")
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(forged_host.status(), StatusCode::FORBIDDEN);
        let cross_site = client
            .post(format!("{base}/api/write"))
            .header("sec-fetch-site", "cross-site")
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(cross_site.status(), StatusCode::FORBIDDEN);
        let read = client
            .get(format!("{base}/api/read"))
            .header(header::ORIGIN, "https://evil.example")
            .send()
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::FORBIDDEN);
        let preflight = client
            .request(reqwest::Method::OPTIONS, format!("{base}/api/write"))
            .header(header::ORIGIN, "https://evil.example")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .send()
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::FORBIDDEN);
        let form = client
            .post(format!("{base}/api/write"))
            .header(header::CONTENT_TYPE, "text/plain")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(form.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(writes.load(Ordering::SeqCst), 0);

        for origin in [
            None,
            Some("https://chasmfiend.local"),
            Some("https://chasmfiend.tail56ddb.ts.net:9443"),
        ] {
            let mut request = client
                .post(format!("{base}/api/write"))
                .json(&serde_json::json!({}));
            if let Some(origin) = origin {
                request = request
                    .header(header::ORIGIN, origin)
                    .header("sec-fetch-site", "same-origin");
            }
            assert_eq!(request.send().await.unwrap().status(), StatusCode::OK);
        }
        assert_eq!(writes.load(Ordering::SeqCst), 3);
        assert_eq!(
            client
                .get(format!("{base}/api/read"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            client
                .get(format!("{base}/"))
                .header(header::ORIGIN, "https://evil.example")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        server.abort();
    }

    #[test]
    fn origin_configuration_rejects_ambiguous_or_unsafe_entries() {
        for value in [
            "*",
            "null",
            "https://reader.local/path",
            "https://reader.local/",
            "https://user@reader.local",
            "ftp://reader.local",
            "https://reader.local?query",
            "https://reader.local#fragment",
            "https://reader.local,",
            "",
        ] {
            assert!(OriginPolicy::parse(value).is_err(), "{value}");
        }
        assert!(
            OriginPolicy::parse(" https://reader.local , https://reader.tail.ts.net:9443 ").is_ok()
        );
    }
}

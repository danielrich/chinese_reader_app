import * as library from "../lib/library";
import * as speed from "../lib/speed";
import { escapeHtml, renderTwoLevelShelfSelector } from "../utils";

// =============================================================================
// Speed View
// =============================================================================

let currentSpeedShelfId: number | null = null;
let currentSpeedPrimaryShelfId: number | null = null;
let currentGraphType: "cumulative" | "known_chars" | "known_words" | "known_char_pct" = "cumulative";
let excludeHighAutoMarked: boolean = false;

export async function loadSpeedView() {
  const container = document.getElementById("speed-main");
  if (!container) return;

  container.innerHTML = '<p class="loading">Loading speed data...</p>';

  try {
    const [stats, data, shelves, autoMarkEnabled] = await Promise.all([
      speed.getSpeedStats(currentSpeedShelfId ?? undefined),
      speed.getSpeedData(currentSpeedShelfId ?? undefined, true, 100),
      library.getShelfTree(),
      library.isAutoMarkEnabled(),
    ]);

    let html = `
      <div class="speed-view">
        <div class="speed-header">
          <h2>Reading Speed</h2>
          <div class="speed-filter">
            <label>Scope:</label>
            ${renderTwoLevelShelfSelector(shelves, "speed", currentSpeedPrimaryShelfId, currentSpeedShelfId)}
          </div>
        </div>

        <div class="speed-stats">
          <div class="stat-card">
            <span class="stat-value">${stats.total_sessions}</span>
            <span class="stat-label">Sessions</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${library.formatCharacterCount(stats.total_characters_read)}</span>
            <span class="stat-label">Chars Read</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${speed.formatDuration(stats.total_reading_time_seconds)}</span>
            <span class="stat-label">Time Spent</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${stats.estimated_completion_seconds ? speed.formatDuration(stats.estimated_completion_seconds) : "-"}</span>
            <span class="stat-label">Est. Remaining</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${speed.formatSpeed(stats.recent_average_speed)}</span>
            <span class="stat-label">Recent Speed</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${library.formatCharacterCount(stats.unread_characters)}</span>
            <span class="stat-label">Unread Chars</span>
          </div>
        </div>

        <div class="speed-settings">
          <label class="toggle-setting">
            <input type="checkbox" id="auto-mark-toggle" ${autoMarkEnabled ? "checked" : ""}>
            <span class="toggle-label">Auto-mark unknown words as known when finishing a reading session</span>
          </label>
          <label class="toggle-setting" style="margin-top: 0.5rem;">
            <input type="checkbox" id="exclude-high-automark-toggle" ${excludeHighAutoMarked ? "checked" : ""}>
            <span class="toggle-label">Exclude sessions with >10% auto-marked from knowledge correlation graphs</span>
          </label>
        </div>

        <div class="speed-graph-section">
          <div class="graph-tabs">
            <button class="graph-tab ${currentGraphType === "cumulative" ? "active" : ""}" data-graph="cumulative">
              Speed vs Experience
            </button>
            <button class="graph-tab ${currentGraphType === "known_char_pct" ? "active" : ""}" data-graph="known_char_pct">
              Speed vs Known %
            </button>
            <button class="graph-tab ${currentGraphType === "known_chars" ? "active" : ""}" data-graph="known_chars">
              Speed vs Known Chars
            </button>
            <button class="graph-tab ${currentGraphType === "known_words" ? "active" : ""}" data-graph="known_words">
              Speed vs Known Words
            </button>
          </div>

          <div class="speed-graph" id="speed-graph">
            ${renderSpeedGraph(data, currentGraphType)}
          </div>
        </div>

        <div class="recent-sessions-section">
          <h3>Recent Sessions</h3>
          ${renderRecentSessions(data)}
        </div>
      </div>
    `;

    container.innerHTML = html;

    setupSpeedViewHandlers(data);

  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load speed data: ${error}</p>`;
  }
}

function calculateLowessSmoothing(
  points: { x: number; y: number }[],
  bandwidth: number = 0.3
): { x: number; y: number }[] {
  if (points.length < 3) return points;

  const sorted = [...points].sort((a, b) => a.x - b.x);
  const n = sorted.length;

  const k = Math.max(3, Math.floor(n * bandwidth));

  const smoothed: { x: number; y: number }[] = [];

  for (const point of sorted) {
    const distances = sorted.map((p, i) => ({
      index: i,
      dist: Math.abs(p.x - point.x),
      p,
    }));
    distances.sort((a, b) => a.dist - b.dist);
    const neighbors = distances.slice(0, k);

    const maxDist = neighbors[neighbors.length - 1].dist || 1;

    let sumWeight = 0;
    let sumWeightedY = 0;

    for (const neighbor of neighbors) {
      const u = neighbor.dist / (maxDist * 1.001);
      const weight = Math.pow(1 - Math.pow(u, 3), 3);
      sumWeight += weight;
      sumWeightedY += weight * neighbor.p.y;
    }

    smoothed.push({
      x: point.x,
      y: sumWeight > 0 ? sumWeightedY / sumWeight : point.y,
    });
  }

  return smoothed;
}

function renderSpeedGraph(data: speed.SpeedDataPoint[], graphType: "cumulative" | "known_chars" | "known_words" | "known_char_pct"): string {
  let filteredData = data;
  if (excludeHighAutoMarked && (graphType === "known_chars" || graphType === "known_words" || graphType === "known_char_pct")) {
    filteredData = speed.filterHighAutoMarked(data);
  }

  if (graphType === "known_char_pct") {
    filteredData = filteredData.filter(d => d.text_known_char_percentage !== null);
  }

  if (filteredData.length === 0) {
    let filterNote = "";
    if (excludeHighAutoMarked && data.length > 0) {
      filterNote = " (all sessions excluded due to high auto-mark filter)";
    } else if (graphType === "known_char_pct" && data.length > 0) {
      filterNote = " (older sessions don't have this data - it will appear for future reading sessions)";
    }
    return `<p class="empty-message graph-empty">No reading sessions yet${filterNote}. Start reading to see your progress!</p>`;
  }

  const graphHeight = 300;

  const points = filteredData.map((d) => {
    let x: number;
    let xLabel: string;

    switch (graphType) {
      case "cumulative":
        x = d.cumulative_characters_read;
        xLabel = `${library.formatCharacterCount(d.cumulative_characters_read)} chars read`;
        break;
      case "known_char_pct":
        x = d.text_known_char_percentage!;
        xLabel = `${d.text_known_char_percentage!.toFixed(1)}% known`;
        break;
      case "known_chars":
        x = d.known_characters_count;
        xLabel = `${d.known_characters_count} known chars`;
        break;
      case "known_words":
        x = d.known_words_count;
        xLabel = `${d.known_words_count} known words`;
        break;
    }

    return {
      x,
      y: d.characters_per_minute,
      xLabel,
      yLabel: `${speed.formatSpeed(d.characters_per_minute)} chars/min`,
      title: d.text_title,
      date: speed.formatSessionDate(d.finished_at),
    };
  });

  const xValues = points.map((p) => p.x);
  const yValues = points.map((p) => p.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues) * 0.9;
  const maxY = Math.max(...yValues) * 1.1;

  const xRange = maxX - minX || 1;
  const yRange = maxY - minY || 1;

  const smoothedPoints = calculateLowessSmoothing(
    points.map(p => ({ x: p.x, y: p.y })),
    0.4
  );

  let trendLineHtml = "";
  if (smoothedPoints.length >= 2) {
    const pathPoints = smoothedPoints.map(p => {
      const xPercent = ((p.x - minX) / xRange) * 90 + 5;
      const yPercent = 100 - ((p.y - minY) / yRange) * 90 - 5;
      return `${xPercent},${yPercent}`;
    });

    trendLineHtml = `
      <svg class="graph-trend-line" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline
          points="${pathPoints.join(" ")}"
          fill="none"
          stroke="rgba(100, 108, 255, 0.6)"
          stroke-width="0.5"
          vector-effect="non-scaling-stroke"
        />
      </svg>
    `;
  }

  const pointsHtml = points
    .map((p, i) => {
      const xPercent = ((p.x - minX) / xRange) * 90 + 5;
      const yPercent = 100 - ((p.y - minY) / yRange) * 90 - 5;

      return `
        <div class="graph-point"
             style="left: ${xPercent}%; top: ${yPercent}%;"
             data-index="${i}"
             title="${escapeHtml(p.title)}">
          <div class="graph-tooltip">
            <strong>${escapeHtml(p.title)}</strong><br>
            ${p.yLabel}<br>
            ${p.xLabel}<br>
            <span class="tooltip-date">${p.date}</span>
          </div>
        </div>
      `;
    })
    .join("");

  let xAxisLabel: string;
  let xMinLabel: string;
  let xMaxLabel: string;

  switch (graphType) {
    case "cumulative":
      xAxisLabel = "Characters Read";
      xMinLabel = library.formatCharacterCount(Math.round(minX));
      xMaxLabel = library.formatCharacterCount(Math.round(maxX));
      break;
    case "known_char_pct":
      xAxisLabel = "Known Character %";
      xMinLabel = `${Math.round(minX)}%`;
      xMaxLabel = `${Math.round(maxX)}%`;
      break;
    case "known_chars":
      xAxisLabel = "Known Characters";
      xMinLabel = library.formatCharacterCount(Math.round(minX));
      xMaxLabel = library.formatCharacterCount(Math.round(maxX));
      break;
    case "known_words":
      xAxisLabel = "Known Words";
      xMinLabel = library.formatCharacterCount(Math.round(minX));
      xMaxLabel = library.formatCharacterCount(Math.round(maxX));
      break;
  }

  return `
    <div class="graph-container" style="height: ${graphHeight}px;">
      <div class="graph-y-axis">
        <span class="axis-label">${Math.round(maxY)}</span>
        <span class="axis-label">${Math.round((maxY + minY) / 2)}</span>
        <span class="axis-label">${Math.round(minY)}</span>
      </div>
      <div class="graph-plot-area">
        ${trendLineHtml}
        ${pointsHtml}
      </div>
      <div class="graph-y-label">chars/min</div>
    </div>
    <div class="graph-x-axis">
      <span class="axis-label">${xMinLabel}</span>
      <span class="axis-label graph-x-label">${xAxisLabel}</span>
      <span class="axis-label">${xMaxLabel}</span>
    </div>
  `;
}

function renderRecentSessions(data: speed.SpeedDataPoint[]): string {
  if (data.length === 0) {
    return '<p class="empty-message">No completed reading sessions yet.</p>';
  }

  const recent = [...data].reverse().slice(0, 10);

  let html = '<div class="recent-sessions-list">';

  for (const session of recent) {
    html += `
      <div class="recent-session-item">
        <div class="session-info">
          <span class="session-title">${escapeHtml(session.text_title)}</span>
          <span class="session-date">${speed.formatSessionDate(session.finished_at)}</span>
        </div>
        <div class="session-stats">
          <span class="session-speed">${speed.formatSpeed(session.characters_per_minute)} chars/min</span>
          <span class="session-chars">${library.formatCharacterCount(session.character_count)} chars</span>
        </div>
      </div>
    `;
  }

  html += '</div>';
  return html;
}

function setupSpeedViewHandlers(data: speed.SpeedDataPoint[]) {
  document.getElementById("speed-shelf-primary")?.addEventListener("change", async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    currentSpeedPrimaryShelfId = value ? parseInt(value) : null;
    currentSpeedShelfId = currentSpeedPrimaryShelfId;
    await loadSpeedView();
  });

  document.getElementById("speed-shelf-secondary")?.addEventListener("change", async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    currentSpeedShelfId = value ? parseInt(value) : currentSpeedPrimaryShelfId;
    await loadSpeedView();
  });

  document.querySelectorAll(".graph-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const graphType = (tab as HTMLElement).dataset.graph as "cumulative" | "known_chars" | "known_words" | "known_char_pct";
      currentGraphType = graphType;

      document.querySelectorAll(".graph-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      const graphContainer = document.getElementById("speed-graph");
      if (graphContainer) {
        graphContainer.innerHTML = renderSpeedGraph(data, graphType);
      }
    });
  });

  document.getElementById("auto-mark-toggle")?.addEventListener("change", async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    try {
      await library.setAutoMarkEnabled(enabled);
    } catch (error) {
      console.error("Failed to update auto-mark setting:", error);
      (e.target as HTMLInputElement).checked = !enabled;
    }
  });

  document.getElementById("exclude-high-automark-toggle")?.addEventListener("change", (e) => {
    excludeHighAutoMarked = (e.target as HTMLInputElement).checked;

    const graphContainer = document.getElementById("speed-graph");
    if (graphContainer) {
      graphContainer.innerHTML = renderSpeedGraph(data, currentGraphType);
    }
  });
}

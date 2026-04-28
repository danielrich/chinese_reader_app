import "./style.css";
import { setupDictionaryView, loadStats } from "./views/dictionary-view";
import { setupLibraryView, loadShelfTree } from "./views/library-view";
import { loadSpeedView } from "./views/speed-view";
import { loadStatsView } from "./views/stats-view";
import { loadPrestudyView } from "./views/prestudy-view";
import { loadLearningView } from "./views/learning-view";

// Global Error Handler
function showError(message: string): void {
  // Create or get error notification container
  let container = document.getElementById("error-notification-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "error-notification-container";
    container.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      pointer-events: none;
    `;
    const target = document.body ?? document.documentElement;
    target.appendChild(container);
  }

  // Create error notification div
  const notification = document.createElement("div");
  notification.style.cssText = `
    background-color: #ff6b6b;
    color: white;
    padding: 16px 20px;
    border-radius: 6px;
    margin-bottom: 10px;
    font-size: 14px;
    line-height: 1.5;
    max-width: 400px;
    word-wrap: break-word;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    pointer-events: auto;
    animation: slideIn 0.3s ease-out;
  `;
  notification.textContent = message;

  // Add animation keyframes if not present (before appending notification)
  if (!document.getElementById("error-animation-styles")) {
    const style = document.createElement("style");
    style.id = "error-animation-styles";
    style.textContent = `
      @keyframes slideIn {
        from {
          transform: translateX(400px);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
    `;
    document.head.appendChild(style);
  }

  container.appendChild(notification);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    notification.style.opacity = "0";
    notification.style.transition = "opacity 0.3s ease-out";
    setTimeout(() => {
      notification.remove();
    }, 300);
  }, 5000);
}

// Handle unhandled promise rejections
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const message = reason instanceof Error
    ? reason.message || "Unknown error"
    : String(reason) || "Unknown error";
  showError(`Promise rejected: ${message}`);
  // Log the error and prevent default handling
  console.error('Unhandled rejection:', reason);
});

// Handle uncaught errors
window.addEventListener("error", (event) => {
  const message = event.message || "Unknown error occurred";
  showError(`Error: ${message}`);
  console.error('Uncaught error:', event.error);
  event.preventDefault();
});

// Initialize the app
async function initApp() {
  const app = document.querySelector<HTMLDivElement>("#app")!;

  app.innerHTML = `
    <div class="container">
      <h1>Chinese Reader</h1>
      <p class="subtitle">A vocabulary tracking and reading comprehension assistant</p>

      <nav class="nav-tabs">
        <button class="nav-tab active" data-view="dictionary">Dictionary</button>
        <button class="nav-tab" data-view="library">Library</button>
        <button class="nav-tab" data-view="learning">Learning</button>
        <button class="nav-tab" data-view="speed">Speed</button>
        <button class="nav-tab" data-view="stats">Stats</button>
        <button class="nav-tab" data-view="prestudy">Pre-Study</button>
      </nav>

      <div id="dictionary-view" class="view active">
        <div class="search-box">
          <input
            type="text"
            id="search-input"
            placeholder="Enter Chinese word or character..."
            autocomplete="off"
          />
          <button id="search-btn">Look up</button>
        </div>

        <div id="results" class="results"></div>

        <div id="stats" class="stats"></div>

        <div class="features">
          <div class="feature">
            <h3>Dictionary Sources</h3>
            <p>CC-CEDICT, MOE Dict, Kangxi Dictionary</p>
          </div>
          <div class="feature">
            <h3>User Dictionaries</h3>
            <p>Create custom dictionaries for book-specific terms</p>
          </div>
          <div class="feature">
            <h3>Examples & Citations</h3>
            <p>See words used in classical and modern contexts</p>
          </div>
          <div class="feature">
            <h3>Character Info</h3>
            <p>Radical, stroke count, decomposition</p>
          </div>
        </div>
      </div>

      <div id="library-view" class="view">
        <button id="shelf-drawer-toggle" class="shelf-drawer-toggle" aria-label="Open shelves">📚 Shelves</button>
        <div id="shelf-drawer-backdrop" class="shelf-drawer-backdrop"></div>
        <div class="library-layout">
          <aside id="shelf-sidebar" class="shelf-sidebar">
            <div class="sidebar-header">
              <h3>Shelves</h3>
              <div class="sidebar-header-actions">
                <button id="add-shelf-btn" class="btn-icon" title="Add Shelf">+</button>
                <button id="shelf-drawer-close" class="btn-icon shelf-drawer-close-btn" aria-label="Close shelves" title="Close">×</button>
              </div>
            </div>
            <div class="shelf-count-legend">counts: total / unread</div>
            <div id="shelf-tree" class="shelf-tree"></div>
          </aside>
          <main class="library-content">
            <div id="library-main"></div>
          </main>
        </div>
      </div>

      <div id="learning-view" class="view">
        <div id="learning-main"></div>
      </div>

      <div id="speed-view" class="view">
        <div id="speed-main"></div>
      </div>

      <div id="stats-view" class="view">
        <div id="stats-main"></div>
      </div>

      <div id="prestudy-view" class="view">
        <div id="prestudy-main"></div>
      </div>
    </div>
  `;

  // Set up navigation
  setupNavigation();

  // Set up dictionary view
  setupDictionaryView();

  // Set up library view
  setupLibraryView();

  // Handle cross-view navigation from learning view to dictionary search
  window.addEventListener("navigate-to-dictionary-search", (e) => {
    const term = (e as CustomEvent<{ term: string }>).detail.term;
    // Switch to dictionary view
    document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    document.querySelector('[data-view="dictionary"]')?.classList.add("active");
    document.getElementById("dictionary-view")?.classList.add("active");
    // Trigger search
    const searchInput = document.getElementById("search-input") as HTMLInputElement;
    if (searchInput) {
      searchInput.value = term;
      document.getElementById("search-btn")?.click();
    }
  });

  // Load initial data
  await loadStats();
}

function setupNavigation() {
  const tabs = document.querySelectorAll(".nav-tab");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const view = (tab as HTMLElement).dataset.view as "dictionary" | "library" | "learning" | "speed" | "stats" | "prestudy";

      // Update active tab
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      // Update active view
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      document.getElementById(`${view}-view`)?.classList.add("active");

      if (view === "library") {
        loadShelfTree();
      } else if (view === "learning") {
        loadLearningView();
      } else if (view === "speed") {
        loadSpeedView();
      } else if (view === "stats") {
        loadStatsView();
      } else if (view === "prestudy") {
        loadPrestudyView();
      }
    });
  });
}

// Initialize on DOM ready — fires exactly once in all cases
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => console.log("SW registered:", reg.scope))
      .catch((err) => console.warn("SW registration failed:", err));
  });
}

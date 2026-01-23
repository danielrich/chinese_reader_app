import "./style.css";
import * as dictionary from "./lib/dictionary";
import * as library from "./lib/library";
import * as speed from "./lib/speed";
import * as learning from "./lib/learning";
import { confirm } from "@tauri-apps/plugin-dialog";

// State
let selectedShelfId: number | null = null;
let shelfTree: library.ShelfTree[] = [];
let activeSession: speed.ReadingSession | null = null;
let sessionTimerInterval: number | null = null;
let currentTextId: number | null = null;
let currentShelfTexts: library.TextSummary[] = [];

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
        <div class="library-layout">
          <aside class="shelf-sidebar">
            <div class="sidebar-header">
              <h3>Shelves</h3>
              <button id="add-shelf-btn" class="btn-icon" title="Add Shelf">+</button>
            </div>
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
    </div>
  `;

  // Set up navigation
  setupNavigation();

  // Set up dictionary view
  setupDictionaryView();

  // Set up library view
  setupLibraryView();

  // Load initial data
  await loadStats();
}

function setupNavigation() {
  const tabs = document.querySelectorAll(".nav-tab");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const view = (tab as HTMLElement).dataset.view as "dictionary" | "library" | "learning" | "speed";

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
      }
    });
  });
}

function setupDictionaryView() {
  const searchInput = document.getElementById("search-input") as HTMLInputElement;
  const searchBtn = document.getElementById("search-btn") as HTMLButtonElement;
  const resultsDiv = document.getElementById("results") as HTMLDivElement;

  async function performSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    resultsDiv.innerHTML = '<p class="loading">Searching...</p>';

    try {
      const result = await dictionary.lookup(query, {
        includeExamples: true,
        includeCharacterInfo: true,
        includeUserDictionaries: true,
      });

      displayDictionaryResults(result);
    } catch (error) {
      resultsDiv.innerHTML = `<p class="error">Error: ${error}</p>`;
    }
  }

  searchBtn.addEventListener("click", performSearch);
  searchInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      performSearch();
    }
  });
}

function displayDictionaryResults(result: dictionary.LookupResult) {
  const resultsDiv = document.getElementById("results") as HTMLDivElement;

  if (result.entries.length === 0 && result.user_entries.length === 0) {
    resultsDiv.innerHTML = `<p class="no-results">No results found for "${result.query}"</p>`;
    return;
  }

  let html = `<h2>Results for "${result.query}"</h2>`;

  // Character info
  if (result.character_info) {
    const char = result.character_info;
    html += `
      <div class="character-info">
        <h3>Character Information</h3>
        <div class="char-details">
          <span class="large-char">${char.character}</span>
          <div class="char-meta">
            ${char.radical ? `<p><strong>Radical:</strong> ${char.radical} (#${char.radical_number})</p>` : ""}
            ${char.total_strokes ? `<p><strong>Strokes:</strong> ${char.total_strokes}</p>` : ""}
            ${char.decomposition ? `<p><strong>Decomposition:</strong> ${char.decomposition}</p>` : ""}
            ${char.variants.length > 0 ? `<p><strong>Variants:</strong> ${char.variants.join(", ")}</p>` : ""}
          </div>
        </div>
      </div>
    `;
  }

  // Group entries by source
  const grouped = dictionary.groupBySource(result.entries);

  for (const [source, entries] of grouped) {
    html += `<div class="source-group">`;
    html += `<h3>${dictionary.getSourceDisplayName(source)}</h3>`;

    for (const entry of entries) {
      html += `
        <div class="entry">
          <div class="entry-header">
            <span class="traditional">${entry.traditional}</span>
            ${entry.simplified !== entry.traditional ? `<span class="simplified">(${entry.simplified})</span>` : ""}
            <span class="pinyin">${dictionary.formatPinyin(entry)}</span>
            ${entry.zhuyin ? `<span class="zhuyin">${entry.zhuyin}</span>` : ""}
          </div>
          <div class="definitions">
            ${entry.definitions
              .map(
                (def) => `
              <div class="definition">
                ${def.part_of_speech ? `<span class="pos">${def.part_of_speech}</span>` : ""}
                <span class="def-text">${def.text}</span>
              </div>
            `
              )
              .join("")}
          </div>
          ${
            entry.examples.length > 0
              ? `
            <div class="examples">
              <h4>Examples</h4>
              ${entry.examples
                .slice(0, 3)
                .map(
                  (ex) => `
                <div class="example">
                  <p class="ex-text">${ex.text}</p>
                  ${ex.translation ? `<p class="ex-trans">${ex.translation}</p>` : ""}
                  ${ex.source ? `<p class="ex-source">— ${ex.source}${ex.source_detail ? `, ${ex.source_detail}` : ""}</p>` : ""}
                </div>
              `
                )
                .join("")}
            </div>
          `
              : ""
          }
        </div>
      `;
    }

    html += `</div>`;
  }

  // User dictionary entries
  if (result.user_entries.length > 0) {
    html += `<div class="source-group">`;
    html += `<h3>User Dictionaries</h3>`;

    for (const entry of result.user_entries) {
      html += `
        <div class="entry user-entry">
          <div class="entry-header">
            <span class="traditional">${entry.term}</span>
            ${entry.pinyin ? `<span class="pinyin">${entry.pinyin}</span>` : ""}
          </div>
          <div class="definitions">
            <div class="definition">
              <span class="def-text">${entry.definition}</span>
            </div>
          </div>
          ${entry.notes ? `<p class="notes">${entry.notes}</p>` : ""}
          ${entry.tags.length > 0 ? `<p class="tags">${entry.tags.map((t) => `<span class="tag">${t}</span>`).join("")}</p>` : ""}
        </div>
      `;
    }

    html += `</div>`;
  }

  resultsDiv.innerHTML = html;
}

async function loadStats() {
  const statsDiv = document.getElementById("stats") as HTMLDivElement;

  try {
    const stats = await dictionary.getStats();

    if (stats.total_entries === 0) {
      statsDiv.innerHTML = `
        <p class="stats-info">
          No dictionaries loaded yet. Run the import scripts to load dictionary data:
          <code>node scripts/download-dictionaries.js --all</code>
        </p>
      `;
    } else {
      statsDiv.innerHTML = `
        <p class="stats-info">
          Loaded: ${stats.total_entries.toLocaleString()} entries
          (CC-CEDICT: ${stats.cedict_entries.toLocaleString()},
          MOE: ${stats.moedict_entries.toLocaleString()},
          Kangxi: ${stats.kangxi_entries.toLocaleString()})
          | ${stats.character_count.toLocaleString()} characters
          | ${stats.user_dictionary_count} user dictionaries
        </p>
      `;
    }
  } catch (error) {
    statsDiv.innerHTML = `<p class="stats-info">Dictionary stats unavailable</p>`;
  }
}

// =============================================================================
// Library View
// =============================================================================

function setupLibraryView() {
  const addShelfBtn = document.getElementById("add-shelf-btn");
  addShelfBtn?.addEventListener("click", showAddShelfModal);
}

async function loadShelfTree() {
  try {
    shelfTree = await library.getShelfTree();
    renderShelfTree();

    if (selectedShelfId) {
      await loadTextsInShelf(selectedShelfId);
    } else {
      renderLibraryWelcome();
    }
  } catch (error) {
    console.error("Failed to load shelf tree:", error);
  }
}

function renderShelfTree() {
  const container = document.getElementById("shelf-tree");
  if (!container) return;

  if (shelfTree.length === 0) {
    container.innerHTML = `<p class="empty-message">No shelves yet. Create one to get started.</p>`;
    return;
  }

  container.innerHTML = renderShelfNodes(shelfTree, 0);

  // Add click handlers
  container.querySelectorAll(".shelf-item").forEach((item) => {
    item.addEventListener("click", async (e) => {
      e.stopPropagation();
      const shelfId = parseInt((item as HTMLElement).dataset.shelfId!);
      selectShelf(shelfId);
    });
  });

  // Add toggle handlers for expand/collapse
  container.querySelectorAll(".shelf-toggle").forEach((toggle) => {
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const parent = (toggle as HTMLElement).closest(".shelf-node");
      parent?.classList.toggle("collapsed");
    });
  });
}

function renderShelfNodes(nodes: library.ShelfTree[], depth: number): string {
  return nodes
    .map((node) => {
      const hasChildren = node.children.length > 0;
      const isSelected = node.shelf.id === selectedShelfId;

      return `
        <div class="shelf-node" data-depth="${depth}">
          <div class="shelf-item ${isSelected ? "selected" : ""}" data-shelf-id="${node.shelf.id}">
            ${hasChildren ? '<span class="shelf-toggle">▶</span>' : '<span class="shelf-toggle-placeholder"></span>'}
            <span class="shelf-name">${escapeHtml(node.shelf.name)}</span>
            <span class="shelf-count">${node.text_count}</span>
          </div>
          ${hasChildren ? `<div class="shelf-children">${renderShelfNodes(node.children, depth + 1)}</div>` : ""}
        </div>
      `;
    })
    .join("");
}

async function selectShelf(shelfId: number) {
  selectedShelfId = shelfId;

  // Update selection in tree
  document.querySelectorAll(".shelf-item").forEach((item) => {
    item.classList.toggle("selected", parseInt((item as HTMLElement).dataset.shelfId!) === shelfId);
  });

  await loadTextsInShelf(shelfId);
}

async function loadTextsInShelf(shelfId: number) {
  const mainContainer = document.getElementById("library-main");
  if (!mainContainer) return;

  try {
    const texts = await library.listTextsInShelf(shelfId);
    currentShelfTexts = texts; // Store for section navigation
    const shelf = findShelfById(shelfTree, shelfId);

    // Get shelf analysis first - this includes sub-shelf texts
    let shelfAnalysis: library.ShelfAnalysis | null = null;
    try {
      shelfAnalysis = await library.getShelfAnalysis(shelfId);
    } catch {
      // Ignore errors - will just not show analysis
    }

    // Check if there are texts (direct or in sub-shelves) to determine if we show analysis with sidebar
    const hasTexts = shelfAnalysis !== null && shelfAnalysis.text_count > 0;

    let html = `
      <div class="shelf-view-layout ${hasTexts ? 'has-analysis' : ''}">
        <div class="shelf-main">
          <div class="shelf-header">
            <h2>${escapeHtml(shelf?.shelf.name || "Shelf")}</h2>
            <div class="shelf-actions">
              <button id="add-text-btn" class="btn-primary">Add Text</button>
              <button id="split-large-texts-btn" class="btn-secondary">Split Large Texts</button>
              <button id="edit-shelf-btn" class="btn-secondary">Edit</button>
              <button id="move-shelf-btn" class="btn-secondary">Move</button>
              <button id="delete-shelf-btn" class="btn-danger">Delete</button>
            </div>
          </div>
    `;

    // Add shelf analysis if there are texts (including sub-shelf texts)
    if (shelfAnalysis !== null && shelfAnalysis.text_count > 0) {
        // Calculate rates based on total occurrences, not unique counts
        const knownCharOccurrences = shelfAnalysis.known_characters.reduce((sum, c) => sum + c.frequency, 0);
        const knownWordOccurrences = shelfAnalysis.known_words.reduce((sum, w) => sum + w.frequency, 0);
        const knownCharRate = shelfAnalysis.total_characters > 0
          ? Math.round((knownCharOccurrences / shelfAnalysis.total_characters) * 100)
          : 100;
        const knownWordRate = shelfAnalysis.total_words > 0
          ? Math.round((knownWordOccurrences / shelfAnalysis.total_words) * 100)
          : 100;

        const formatShelfFreqItem = (item: library.CharacterFrequency | library.WordFrequency, type: "character" | "word") => {
          const label = type === "character" ? (item as library.CharacterFrequency).character : (item as library.WordFrequency).word;
          return `
            <div class="freq-item ${item.is_known ? "known" : "unknown"}" data-lookup="${escapeHtml(label)}" data-lookup-type="${type}">
              <span class="freq-${type === "character" ? "char" : "word"} freq-clickable">${label}</span>
              <span class="freq-count">${item.frequency}x</span>
              ${!item.is_known
                ? `<button class="btn-mark-known-shelf" data-word="${label}" data-type="${type}">Mark Known</button>`
                : '<span class="known-badge">Known</span>'
              }
            </div>
          `;
        };

        html += `
          <div class="shelf-analysis">
            <h3>Shelf Analysis</h3>
            <div class="analysis-summary shelf-stats">
              <div class="stat-card">
                <span class="stat-value">${shelfAnalysis.text_count}</span>
                <span class="stat-label">Texts</span>
              </div>
              <div class="stat-card">
                <span class="stat-value">${library.formatCharacterCount(shelfAnalysis.total_characters)}</span>
                <span class="stat-label">Total Characters</span>
              </div>
              <div class="stat-card">
                <span class="stat-value">${shelfAnalysis.unique_characters}</span>
                <span class="stat-label">Unique Characters</span>
              </div>
              <div class="stat-card ${knownCharRate >= 98 ? "highlight-good" : knownCharRate < 90 ? "highlight-bad" : ""}">
                <span class="stat-value">${knownCharRate}%</span>
                <span class="stat-label">Known Char Rate</span>
              </div>
              <div class="stat-card">
                <span class="stat-value">${shelfAnalysis.unique_words}</span>
                <span class="stat-label">Unique Words</span>
              </div>
              <div class="stat-card ${knownWordRate >= 98 ? "highlight-good" : knownWordRate < 90 ? "highlight-bad" : ""}">
                <span class="stat-value">${knownWordRate}%</span>
                <span class="stat-label">Known Word Rate</span>
              </div>
            </div>

            <div class="analysis-sections">
              <div class="analysis-section">
                <h3>Unknown Characters (${shelfAnalysis.unknown_characters.length})</h3>
                <div class="freq-list">
                  ${shelfAnalysis.unknown_characters.length === 0
                    ? '<p class="empty-message">All characters are known!</p>'
                    : shelfAnalysis.unknown_characters.slice(0, 50).map(cf => formatShelfFreqItem(cf, "character")).join("")
                  }
                </div>
              </div>

              <div class="analysis-section">
                <h3>Known Characters (${shelfAnalysis.known_characters.length})</h3>
                <div class="freq-list">
                  ${shelfAnalysis.known_characters.length === 0
                    ? '<p class="empty-message">No known characters yet.</p>'
                    : shelfAnalysis.known_characters.slice(0, 50).map(cf => formatShelfFreqItem(cf, "character")).join("")
                  }
                </div>
              </div>

              <div class="analysis-section">
                <h3>Unknown Words (${shelfAnalysis.unknown_words.length})</h3>
                <div class="freq-list">
                  ${shelfAnalysis.unknown_words.length === 0
                    ? '<p class="empty-message">All words are known!</p>'
                    : shelfAnalysis.unknown_words.slice(0, 50).map(wf => formatShelfFreqItem(wf, "word")).join("")
                  }
                </div>
              </div>

              <div class="analysis-section">
                <h3>Known Words (${shelfAnalysis.known_words.length})</h3>
                <div class="freq-list">
                  ${shelfAnalysis.known_words.length === 0
                    ? '<p class="empty-message">No known words yet.</p>'
                    : shelfAnalysis.known_words.slice(0, 50).map(wf => formatShelfFreqItem(wf, "word")).join("")
                  }
                </div>
              </div>
            </div>
          </div>
        `;
    }

    if (texts.length === 0) {
      html += `<p class="empty-message">No texts in this shelf yet. Add one to get started.</p>`;
    } else {
      html += `<div class="text-list">`;
      for (const text of texts) {
        html += `
          <div class="text-item" data-text-id="${text.id}">
            <div class="text-info">
              <h4 class="text-title">${escapeHtml(text.title)}</h4>
              ${text.author ? `<p class="text-author">${escapeHtml(text.author)}</p>` : ""}
            </div>
            <div class="text-meta">
              <span class="text-chars">${library.formatCharacterCount(text.character_count)} chars</span>
              ${text.has_analysis ? '<span class="text-analyzed">Analyzed</span>' : ""}
            </div>
          </div>
        `;
      }
      html += `</div>`;
    }

    // Close shelf-main div
    html += `</div>`;

    // Add dictionary sidebar for shelf analysis (only if we have texts)
    if (hasTexts) {
      html += `
        <aside class="dict-sidebar" id="shelf-dict-sidebar">
          <div class="dict-sidebar-header">
            <h3>Dictionary</h3>
            <button class="dict-sidebar-close" id="shelf-dict-sidebar-close">&times;</button>
          </div>
          <div class="dict-sidebar-content" id="shelf-dict-sidebar-content">
            <p class="dict-sidebar-empty">Click on a word or character to look it up</p>
          </div>
        </aside>
      `;
    }

    // Close shelf-view-layout div
    html += `</div>`;

    mainContainer.innerHTML = html;

    // Add event listeners
    document.getElementById("add-text-btn")?.addEventListener("click", () => showAddTextModal(shelfId));
    document.getElementById("split-large-texts-btn")?.addEventListener("click", () => splitLargeTextsInShelf(shelfId));
    document.getElementById("edit-shelf-btn")?.addEventListener("click", () => showEditShelfModal(shelfId));
    document.getElementById("move-shelf-btn")?.addEventListener("click", () => showMoveShelfModal(shelfId));
    document.getElementById("delete-shelf-btn")?.addEventListener("click", () => confirmDeleteShelf(shelfId));

    // Text item clicks
    mainContainer.querySelectorAll(".text-item").forEach((item) => {
      item.addEventListener("click", () => {
        const textId = parseInt((item as HTMLElement).dataset.textId!);
        loadTextView(textId);
      });
    });

    // Shelf analysis mark known handlers - optimistic UI update
    mainContainer.querySelectorAll(".btn-mark-known-shelf").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const word = (btn as HTMLElement).dataset.word!;
        const wordType = (btn as HTMLElement).dataset.type!;
        const freqItem = (btn as HTMLElement).closest(".freq-item");

        // Optimistic UI update - immediately update the button
        (btn as HTMLButtonElement).textContent = "Marked!";
        (btn as HTMLButtonElement).disabled = true;
        freqItem?.classList.remove("unknown");
        freqItem?.classList.add("known");

        try {
          await library.addKnownWord(word, wordType);
          // Replace button with known badge
          btn.outerHTML = '<span class="known-badge">Known</span>';
        } catch (error) {
          console.error("Failed to mark as known:", error);
          // Revert UI on error
          (btn as HTMLButtonElement).textContent = "Mark Known";
          (btn as HTMLButtonElement).disabled = false;
          freqItem?.classList.add("unknown");
          freqItem?.classList.remove("known");
        }
      });
    });

    // Shelf analysis click handlers for dictionary lookup
    mainContainer.querySelectorAll(".shelf-analysis .freq-item[data-lookup]").forEach((item) => {
      item.addEventListener("click", (e) => {
        // Don't trigger if clicking the button
        if ((e.target as HTMLElement).closest(".btn-mark-known-shelf")) return;

        const term = (item as HTMLElement).dataset.lookup!;
        const termType = (item as HTMLElement).dataset.lookupType as "character" | "word";

        // Highlight selected item
        mainContainer.querySelectorAll(".shelf-analysis .freq-item").forEach(el => el.classList.remove("selected"));
        item.classList.add("selected");

        // Look up in shelf sidebar
        lookupInShelfSidebar(term, termType);
      });
    });

    // Shelf sidebar close button
    document.getElementById("shelf-dict-sidebar-close")?.addEventListener("click", () => {
      const content = document.getElementById("shelf-dict-sidebar-content");
      if (content) {
        content.innerHTML = '<p class="dict-sidebar-empty">Click on a word or character to look it up</p>';
      }
      // Deselect any selected items
      mainContainer.querySelectorAll(".freq-item.selected").forEach(el => el.classList.remove("selected"));
    });
  } catch (error) {
    mainContainer.innerHTML = `<p class="error">Failed to load texts: ${error}</p>`;
  }
}

async function loadTextView(textId: number) {
  const mainContainer = document.getElementById("library-main");
  if (!mainContainer) return;

  // Clear any existing timer
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }

  try {
    const text = await library.getText(textId);

    // Check for active reading session
    activeSession = await speed.getActiveReadingSession(textId);

    // Find current text index for section navigation
    const currentTextIndex = currentShelfTexts.findIndex(t => t.id === textId);
    const hasPrevSection = currentTextIndex > 0;
    const hasNextSection = currentTextIndex >= 0 && currentTextIndex < currentShelfTexts.length - 1;
    const prevTextId = hasPrevSection ? currentShelfTexts[currentTextIndex - 1].id : null;
    const nextTextId = hasNextSection ? currentShelfTexts[currentTextIndex + 1].id : null;

    let html = `
      <div class="text-view">
        <div class="text-header">
          <button id="back-to-shelf-btn" class="btn-secondary" data-text-id="${textId}">Back</button>
          <div class="section-nav">
            <button id="prev-section-btn" class="btn-secondary" ${hasPrevSection ? `data-text-id="${prevTextId}"` : 'disabled'}>Previous</button>
            <button id="next-section-btn" class="btn-secondary" ${hasNextSection ? `data-text-id="${nextTextId}"` : 'disabled'}>Next</button>
          </div>
          <div class="text-title-group">
            <h2>${escapeHtml(text.title)}</h2>
            ${text.author ? `<p class="text-author">by ${escapeHtml(text.author)}</p>` : ""}
          </div>
          <div class="reading-controls" id="reading-controls">
            ${activeSession
              ? `
                <span class="session-timer" id="session-timer">${speed.formatElapsedTime(activeSession.started_at)}</span>
                <button id="finish-reading-btn" class="btn-primary">Finish Reading</button>
                <button id="discard-reading-btn" class="btn-secondary">Discard</button>
              `
              : `<button id="start-reading-btn" class="btn-primary">Start Reading</button>`
            }
          </div>
          <div class="text-actions">
            <button id="analyze-text-btn" class="btn-secondary">Analyze</button>
            <button id="delete-text-btn" class="btn-danger">Delete</button>
          </div>
        </div>

        <div class="text-tabs">
          <button class="text-tab active" data-tab="content">Content</button>
          <button class="text-tab" data-tab="analysis">Analysis</button>
          <button class="text-tab" data-tab="history">History</button>
        </div>

        <div class="text-view-layout">
          <div class="text-main">
            <div id="text-content-tab" class="text-tab-content active">
              <div id="text-content-interactive" class="text-content-interactive">
                <p class="loading">Loading text...</p>
              </div>
            </div>

            <div id="text-analysis-tab" class="text-tab-content">
              <div id="analysis-container">
                <p class="loading">Loading analysis...</p>
              </div>
            </div>

            <div id="text-history-tab" class="text-tab-content">
              <div id="history-container">
                <p class="loading">Loading history...</p>
              </div>
            </div>
          </div>

          <aside class="dict-sidebar" id="dict-sidebar">
            <div class="dict-sidebar-header">
              <h3>Dictionary</h3>
              <button class="dict-sidebar-close" id="dict-sidebar-close">&times;</button>
            </div>
            <div class="dict-sidebar-content" id="dict-sidebar-content">
              <p class="dict-sidebar-empty">Click on a word or character to look it up</p>
            </div>
          </aside>
        </div>
      </div>
    `;

    mainContainer.innerHTML = html;

    // Load segmented text
    loadInteractiveText(text.content, textId);

    // Start timer if there's an active session
    if (activeSession) {
      startSessionTimer(activeSession.started_at);
    }

    // Set up tab switching
    mainContainer.querySelectorAll(".text-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const tabName = (tab as HTMLElement).dataset.tab;

        mainContainer.querySelectorAll(".text-tab").forEach((t) => t.classList.remove("active"));
        mainContainer.querySelectorAll(".text-tab-content").forEach((c) => c.classList.remove("active"));

        tab.classList.add("active");
        document.getElementById(`text-${tabName}-tab`)?.classList.add("active");

        if (tabName === "analysis") {
          loadAnalysis(textId);
        } else if (tabName === "history") {
          loadReadingHistory(textId);
        }
      });
    });

    // Set up button handlers
    document.getElementById("back-to-shelf-btn")?.addEventListener("click", () => {
      // Clear timer when leaving
      if (sessionTimerInterval) {
        clearInterval(sessionTimerInterval);
        sessionTimerInterval = null;
      }
      if (selectedShelfId) loadTextsInShelf(selectedShelfId);
    });

    // Section navigation handlers
    document.getElementById("prev-section-btn")?.addEventListener("click", (e) => {
      const btn = e.target as HTMLButtonElement;
      if (btn.disabled) return;
      const prevId = parseInt(btn.dataset.textId || "0");
      if (prevId) {
        // Clear timer when navigating
        if (sessionTimerInterval) {
          clearInterval(sessionTimerInterval);
          sessionTimerInterval = null;
        }
        loadTextView(prevId);
      }
    });

    document.getElementById("next-section-btn")?.addEventListener("click", (e) => {
      const btn = e.target as HTMLButtonElement;
      if (btn.disabled) return;
      const nextId = parseInt(btn.dataset.textId || "0");
      if (nextId) {
        // Clear timer when navigating
        if (sessionTimerInterval) {
          clearInterval(sessionTimerInterval);
          sessionTimerInterval = null;
        }
        loadTextView(nextId);
      }
    });

    document.getElementById("analyze-text-btn")?.addEventListener("click", async () => {
      await library.reanalyzeText(textId);
      // Switch to analysis tab
      mainContainer.querySelector('[data-tab="analysis"]')?.dispatchEvent(new Event("click"));
    });

    document.getElementById("delete-text-btn")?.addEventListener("click", () => confirmDeleteText(textId));

    // Reading control buttons
    setupReadingControls(textId);

    // Set up sidebar close button
    document.getElementById("dict-sidebar-close")?.addEventListener("click", () => {
      const content = document.getElementById("dict-sidebar-content");
      if (content) {
        content.innerHTML = '<p class="dict-sidebar-empty">Click on a word or character to look it up</p>';
      }
      // Deselect any selected segments
      document.querySelectorAll(".text-segment.selected").forEach(el => el.classList.remove("selected"));
    });
  } catch (error) {
    mainContainer.innerHTML = `<p class="error">Failed to load text: ${error}</p>`;
  }
}

// Helper to finish the current reading session with auto-mark support
async function finishCurrentReadingSession(): Promise<void> {
  if (!activeSession) return;

  const textId = activeSession.text_id;

  try {
    const finished = await speed.finishReadingSession(activeSession.id);
    if (sessionTimerInterval) {
      clearInterval(sessionTimerInterval);
      sessionTimerInterval = null;
    }

    // Check if auto-mark is enabled and mark unknown words/chars as known
    let autoMarkMessage = "";
    const autoMarkEnabled = await library.isAutoMarkEnabled();
    if (autoMarkEnabled) {
      try {
        const stats = await library.autoMarkTextAsKnown(textId);
        if (stats.characters_marked > 0 || stats.words_marked > 0) {
          autoMarkMessage = `\n\nAuto-marked: ${stats.characters_marked} characters, ${stats.words_marked} words`;

          // Record auto-marked counts on the session for filtering in speed analysis
          await speed.updateSessionAutoMarked(
            finished.id,
            stats.characters_marked,
            stats.words_marked
          );

          // Reload the interactive text to show updated highlighting
          const textContent = document.getElementById("text-content-container");
          if (textContent) {
            const text = await library.getText(textId);
            loadInteractiveText(text.content, textId);
          }
        }
      } catch (autoMarkError) {
        console.error("Failed to auto-mark words:", autoMarkError);
      }
    }

    activeSession = null;
    updateReadingControlsUI();

    // Show completion message
    const cpm = finished.characters_per_minute?.toFixed(1) || "0";
    const duration = speed.formatDuration(finished.duration_seconds || 0);
    alert(`Reading complete!\n\nTime: ${duration}\nSpeed: ${cpm} chars/min${autoMarkMessage}`);
  } catch (error) {
    console.error("Failed to finish reading session:", error);
    alert(`Failed to finish reading: ${error}`);
  }
}

// Set up reading control button handlers
function setupReadingControls(textId: number) {
  document.getElementById("start-reading-btn")?.addEventListener("click", async () => {
    try {
      activeSession = await speed.startReadingSession(textId);
      updateReadingControlsUI();
      startSessionTimer(activeSession.started_at);
    } catch (error) {
      console.error("Failed to start reading session:", error);
      alert(`Failed to start reading: ${error}`);
    }
  });

  document.getElementById("finish-reading-btn")?.addEventListener("click", finishCurrentReadingSession);

  document.getElementById("discard-reading-btn")?.addEventListener("click", async () => {
    if (!activeSession) return;
    const confirmed = await confirm("Discard this reading session? This cannot be undone.");
    if (!confirmed) return;

    try {
      await speed.discardReadingSession(activeSession.id);
      if (sessionTimerInterval) {
        clearInterval(sessionTimerInterval);
        sessionTimerInterval = null;
      }
      activeSession = null;
      updateReadingControlsUI();
    } catch (error) {
      console.error("Failed to discard reading session:", error);
      alert(`Failed to discard: ${error}`);
    }
  });
}

// Update the reading controls UI based on current state
function updateReadingControlsUI() {
  const container = document.getElementById("reading-controls");
  if (!container) return;

  if (activeSession) {
    container.innerHTML = `
      <span class="session-timer" id="session-timer">${speed.formatElapsedTime(activeSession.started_at)}</span>
      <button id="finish-reading-btn" class="btn-primary">Finish Reading</button>
      <button id="discard-reading-btn" class="btn-secondary">Discard</button>
    `;
    // Re-attach handlers
    document.getElementById("finish-reading-btn")?.addEventListener("click", finishCurrentReadingSession);

    document.getElementById("discard-reading-btn")?.addEventListener("click", async () => {
      if (!activeSession) return;
      const confirmed = await confirm("Discard this reading session? This cannot be undone.");
      if (!confirmed) return;
      try {
        await speed.discardReadingSession(activeSession.id);
        if (sessionTimerInterval) {
          clearInterval(sessionTimerInterval);
          sessionTimerInterval = null;
        }
        activeSession = null;
        updateReadingControlsUI();
      } catch (error) {
        console.error("Failed to discard reading session:", error);
        alert(`Failed to discard: ${error}`);
      }
    });
  } else {
    container.innerHTML = `<button id="start-reading-btn" class="btn-primary">Start Reading</button>`;

    document.getElementById("start-reading-btn")?.addEventListener("click", async () => {
      // Get textId from the back button's data attribute
      const backBtn = document.getElementById("back-to-shelf-btn");
      const currentTextId = backBtn ? parseInt((backBtn as HTMLElement).dataset.textId || "0") : 0;
      if (!currentTextId) return;

      try {
        activeSession = await speed.startReadingSession(currentTextId);
        updateReadingControlsUI();
        startSessionTimer(activeSession.started_at);
      } catch (error) {
        console.error("Failed to start reading session:", error);
        alert(`Failed to start reading: ${error}`);
      }
    });
  }
}

// Start the session timer
function startSessionTimer(startedAt: string) {
  const timerEl = document.getElementById("session-timer");
  if (!timerEl) return;

  // Update immediately
  timerEl.textContent = speed.formatElapsedTime(startedAt);

  // Update every second
  sessionTimerInterval = window.setInterval(() => {
    const el = document.getElementById("session-timer");
    if (el) {
      el.textContent = speed.formatElapsedTime(startedAt);
    }
  }, 1000);
}

// Load reading history for a text
async function loadReadingHistory(textId: number) {
  const container = document.getElementById("history-container");
  if (!container) return;

  try {
    const history = await speed.getTextReadingHistory(textId);

    if (history.length === 0) {
      container.innerHTML = '<p class="empty-message">No reading sessions yet. Start reading to track your progress!</p>';
      return;
    }

    let html = `
      <div class="reading-history">
        <h3>Reading Sessions</h3>
        <div class="history-list">
    `;

    for (const session of history) {
      const statusClass = session.is_complete ? "complete" : "in-progress";
      const statusText = session.is_complete ? "Completed" : "In Progress";
      const firstReadBadge = session.is_first_read ? '<span class="first-read-badge">First Read</span>' : '';

      html += `
        <div class="history-item ${statusClass}" data-session-id="${session.id}">
          <div class="history-item-header">
            <span class="history-date">${speed.formatSessionDate(session.started_at)}</span>
            <span class="history-status">${statusText}</span>
            ${firstReadBadge}
            <button class="btn-delete-session" data-session-id="${session.id}" title="Delete session">×</button>
          </div>
          <div class="history-item-stats">
            ${session.is_complete
              ? `
                <span class="history-stat">
                  <strong>${speed.formatDuration(session.duration_seconds || 0)}</strong>
                  <span>Duration</span>
                </span>
                <span class="history-stat">
                  <strong>${speed.formatSpeed(session.characters_per_minute || 0)}</strong>
                  <span>chars/min</span>
                </span>
              `
              : `<span class="history-stat"><strong>${speed.formatElapsedTime(session.started_at)}</strong><span>Elapsed</span></span>`
            }
            <span class="history-stat">
              <strong>${session.character_count}</strong>
              <span>Characters</span>
            </span>
          </div>
        </div>
      `;
    }

    html += `</div></div>`;
    container.innerHTML = html;

    // Add delete button handlers
    container.querySelectorAll(".btn-delete-session").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const sessionId = parseInt((btn as HTMLElement).dataset.sessionId!);

        // Double-click protection: disable button immediately
        const button = btn as HTMLButtonElement;
        if (button.disabled) return;
        button.disabled = true;
        button.textContent = "...";

        try {
          await speed.deleteReadingSession(sessionId);

          // Remove the item from the DOM
          const item = container.querySelector(`.history-item[data-session-id="${sessionId}"]`);
          item?.remove();

          // If no items left, show empty message
          const remainingItems = container.querySelectorAll(".history-item");
          if (remainingItems.length === 0) {
            container.innerHTML = '<p class="empty-message">No reading sessions yet. Start reading to track your progress!</p>';
          }
        } catch (error) {
          console.error("Failed to delete session:", error);
          alert(`Failed to delete session: ${error}`);
          // Re-enable button on error
          button.disabled = false;
          button.textContent = "×";
        }
      });
    });
  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load history: ${error}</p>`;
  }
}

// Load interactive segmented text
async function loadInteractiveText(content: string, textId: number) {
  const container = document.getElementById("text-content-interactive");
  if (!container) return;

  // Store current text ID for refresh
  currentTextId = textId;

  try {
    const segments = await library.segmentText(content);

    let html = "";
    for (const segment of segments) {
      if (segment.is_cjk) {
        let statusClass = "";
        if (segment.is_learning) {
          statusClass = "learning";
        } else if (!segment.is_known) {
          statusClass = "unknown";
        }
        html += `<span class="text-segment ${statusClass}" data-text="${escapeHtml(segment.text)}" data-type="${segment.segment_type}">${escapeHtml(segment.text)}</span>`;
      } else {
        // Preserve whitespace and line breaks
        html += segment.text.replace(/\n/g, "<br>");
      }
    }

    container.innerHTML = html;

    // Add click handlers to segments
    container.querySelectorAll(".text-segment").forEach((el) => {
      el.addEventListener("click", () => {
        const text = (el as HTMLElement).dataset.text!;
        const type = (el as HTMLElement).dataset.type!;

        // Mark as selected
        document.querySelectorAll(".text-segment.selected").forEach(s => s.classList.remove("selected"));
        el.classList.add("selected");

        // Look up in dictionary
        lookupInSidebar(text, type === "character" ? "character" : "word");
      });
    });

    // Add mouseup handler for text selection
    container.addEventListener("mouseup", handleTextSelection);
  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load text: ${error}</p>`;
  }
}

// Check if a character is CJK
function isCjkCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF);
}

// Handle text selection in the reading view
function handleTextSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const selectedText = selection.toString().trim();
  if (!selectedText) return;

  // Check if selection contains at least one CJK character
  const hasCjk = [...selectedText].some(isCjkCharacter);
  if (!hasCjk) return;

  // Only handle selections of pure CJK characters (for simplicity)
  const isAllCjk = [...selectedText].every(c => isCjkCharacter(c) || c === ' ' || c === '\n');
  if (!isAllCjk) return;

  // Clean up the selection (remove whitespace)
  const cleanedText = selectedText.replace(/\s+/g, '');
  if (cleanedText.length === 0) return;

  // Clear segment selection
  document.querySelectorAll(".text-segment.selected").forEach(s => s.classList.remove("selected"));

  // Look up the selected text in the sidebar
  lookupSelectedText(cleanedText);
}

// Look up selected text and show with "Add as Word" option
async function lookupSelectedText(selectedText: string) {
  const sidebarContent = document.getElementById("dict-sidebar-content");
  if (!sidebarContent) return;

  sidebarContent.innerHTML = '<p class="loading">Looking up...</p>';

  try {
    const termType = selectedText.length === 1 ? "character" : "word";
    const result = await dictionary.lookup(selectedText, {
      includeExamples: true,
      includeCharacterInfo: termType === "character",
      includeUserDictionaries: true,
    });

    renderSidebarResultsForSelection(result, selectedText, termType);
  } catch (error) {
    sidebarContent.innerHTML = `<p class="error">Lookup failed: ${error}</p>`;
  }
}

// Render sidebar results for a text selection with "Add as Word" button
function renderSidebarResultsForSelection(
  result: dictionary.LookupResult,
  selectedText: string,
  termType: "character" | "word"
) {
  const sidebarContent = document.getElementById("dict-sidebar-content");
  if (!sidebarContent) return;

  const hasEntries = result.entries.length > 0 || result.user_entries.length > 0;

  // Selection header showing what was selected
  let html = `
    <div class="selection-header">
      <span class="selected-text">${escapeHtml(selectedText)}</span>
      <span class="selection-label">Selected text</span>
    </div>
  `;

  // Action buttons - show "Add as Word" only if there are dictionary entries
  html += `<div class="dict-sidebar-actions-top">`;

  if (hasEntries) {
    html += `
      <button class="btn-primary btn-add-as-word" data-word="${escapeHtml(selectedText)}" data-type="${termType}">
        Add as Word
      </button>
    `;
  }

  html += `
    <button class="btn-secondary btn-mark-known-sidebar" data-word="${escapeHtml(selectedText)}" data-type="${termType}">
      Mark Known
    </button>
    <button class="btn-secondary btn-mark-learning-sidebar" data-word="${escapeHtml(selectedText)}" data-type="${termType}">
      Mark Learning
    </button>
  </div>
  `;

  if (!hasEntries) {
    // Show a form to define the word
    html += `
      <p class="dict-sidebar-empty">No dictionary entries found for "${escapeHtml(selectedText)}"</p>
      <div class="define-word-form">
        <h4>Define this word</h4>
        <form id="define-word-form">
          <div class="form-group">
            <label for="define-definition">Definition *</label>
            <textarea id="define-definition" required rows="2" placeholder="Enter your definition..."></textarea>
          </div>
          <div class="form-group">
            <label for="define-pinyin">Pinyin</label>
            <input type="text" id="define-pinyin" placeholder="e.g., pīn yīn" />
          </div>
          <div class="form-group">
            <label for="define-notes">Notes</label>
            <input type="text" id="define-notes" placeholder="Optional notes..." />
          </div>
          <div class="form-group form-checkbox">
            <label>
              <input type="checkbox" id="define-shelf-specific" />
              Shelf-specific
            </label>
          </div>
          <div class="form-group shelf-selector" id="shelf-selector-group" style="display: none;">
            <label for="define-shelf">Shelf</label>
            <select id="define-shelf">
              <option value="">Loading shelves...</option>
            </select>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn-primary" data-word="${escapeHtml(selectedText)}" data-type="${termType}">
              Define & Add
            </button>
          </div>
        </form>
      </div>
    `;
    sidebarContent.innerHTML = html;
    setupSidebarMarkKnown();
    setupDefineWordForm(selectedText, termType);
    return;
  }

  // Character info (compact)
  if (result.character_info) {
    const char = result.character_info;
    html += `
      <div class="entry">
        <div class="entry-header">
          <span class="traditional" style="font-size: 2rem;">${char.character}</span>
        </div>
        <div style="font-size: 0.85rem; color: #888; margin-top: 0.5rem;">
          ${char.radical ? `Radical: ${char.radical} (#${char.radical_number})` : ""}
          ${char.total_strokes ? ` · ${char.total_strokes} strokes` : ""}
        </div>
      </div>
    `;
  }

  // Dictionary entries (compact)
  for (const entry of result.entries.slice(0, 5)) {
    html += `
      <div class="entry">
        <div class="entry-header">
          <span class="traditional">${entry.traditional}</span>
          ${entry.simplified !== entry.traditional ? `<span class="simplified">(${entry.simplified})</span>` : ""}
          <span class="pinyin">${dictionary.formatPinyin(entry)}</span>
        </div>
        <div class="definitions">
          ${entry.definitions.slice(0, 3)
            .map(def => `
              <div class="definition">
                ${def.part_of_speech ? `<span class="pos">${def.part_of_speech}</span>` : ""}
                <span class="def-text">${def.text}</span>
              </div>
            `)
            .join("")}
        </div>
      </div>
    `;
  }

  // User entries
  for (const entry of result.user_entries.slice(0, 3)) {
    html += `
      <div class="entry user-entry">
        <div class="entry-header">
          <span class="traditional">${entry.term}</span>
          ${entry.pinyin ? `<span class="pinyin">${entry.pinyin}</span>` : ""}
        </div>
        <div class="definitions">
          <div class="definition">
            <span class="def-text">${entry.definition}</span>
          </div>
        </div>
      </div>
    `;
  }

  sidebarContent.innerHTML = html;
  setupSidebarMarkKnown();
  setupAddAsWordButton();
}

// Set up "Add as Word" button handler
function setupAddAsWordButton() {
  document.querySelectorAll(".btn-add-as-word").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const word = (btn as HTMLElement).dataset.word!;

      // Optimistic UI update
      (btn as HTMLButtonElement).textContent = "Adding...";
      (btn as HTMLButtonElement).disabled = true;

      try {
        // Add the word to segmentation (and optionally to vocabulary)
        await library.addCustomSegmentationWord(word, true, "known");

        (btn as HTMLButtonElement).textContent = "Added!";

        // Refresh the text to show new segmentation
        await refreshCurrentText();
      } catch (error) {
        console.error("Failed to add word:", error);
        (btn as HTMLButtonElement).textContent = "Add as Word";
        (btn as HTMLButtonElement).disabled = false;
        alert(`Failed to add word: ${error}`);
      }
    });
  });
}

// Set up the "Define Word" form for undefined words
function setupDefineWordForm(word: string, _termType: "character" | "word") {
  const form = document.getElementById("define-word-form") as HTMLFormElement;
  const shelfSpecificCheckbox = document.getElementById("define-shelf-specific") as HTMLInputElement;
  const shelfSelectorGroup = document.getElementById("shelf-selector-group") as HTMLDivElement;
  const shelfSelect = document.getElementById("define-shelf") as HTMLSelectElement;

  if (!form) return;

  // Load shelves for the dropdown
  loadShelvesForDefineForm(shelfSelect);

  // Toggle shelf selector visibility
  shelfSpecificCheckbox?.addEventListener("change", () => {
    if (shelfSelectorGroup) {
      shelfSelectorGroup.style.display = shelfSpecificCheckbox.checked ? "block" : "none";
    }
  });

  // Handle form submission
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const definition = (document.getElementById("define-definition") as HTMLTextAreaElement).value.trim();
    const pinyin = (document.getElementById("define-pinyin") as HTMLInputElement).value.trim() || undefined;
    const notes = (document.getElementById("define-notes") as HTMLInputElement).value.trim() || undefined;
    const isShelfSpecific = shelfSpecificCheckbox?.checked || false;
    const shelfId = isShelfSpecific && shelfSelect?.value ? parseInt(shelfSelect.value) : undefined;

    if (!definition) {
      alert("Definition is required");
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    submitBtn.textContent = "Adding...";
    submitBtn.disabled = true;

    try {
      await library.defineCustomWord(word, definition, pinyin, notes, shelfId, true, "known");

      submitBtn.textContent = "Added!";

      // Refresh the text to show new segmentation
      await refreshCurrentText();
    } catch (error) {
      console.error("Failed to define word:", error);
      submitBtn.textContent = "Define & Add";
      submitBtn.disabled = false;
      alert(`Failed to define word: ${error}`);
    }
  });
}

// Load shelves into the define form dropdown
async function loadShelvesForDefineForm(selectElement: HTMLSelectElement) {
  if (!selectElement) return;

  try {
    const shelves = await library.getShelfTree();
    const flatShelves = library.flattenShelfTree(shelves);

    let optionsHtml = '<option value="">Select a shelf...</option>';
    for (const node of flatShelves) {
      // Calculate depth for indentation
      const depth = getShelfDepth(shelves, node.shelf.id);
      const indent = "—".repeat(depth);
      optionsHtml += `<option value="${node.shelf.id}">${indent}${escapeHtml(node.shelf.name)}</option>`;
    }

    selectElement.innerHTML = optionsHtml;

    // Pre-select current shelf if viewing a text
    if (selectedShelfId) {
      selectElement.value = selectedShelfId.toString();
    }
  } catch (error) {
    console.error("Failed to load shelves:", error);
    selectElement.innerHTML = '<option value="">Failed to load shelves</option>';
  }
}

// Get the depth of a shelf in the tree
function getShelfDepth(tree: library.ShelfTree[], shelfId: number, currentDepth: number = 0): number {
  for (const node of tree) {
    if (node.shelf.id === shelfId) {
      return currentDepth;
    }
    const childDepth = getShelfDepth(node.children, shelfId, currentDepth + 1);
    if (childDepth !== -1) {
      return childDepth;
    }
  }
  return -1;
}

// Refresh the current text view after adding a custom word
async function refreshCurrentText() {
  if (!currentTextId) return;

  try {
    const text = await library.getText(currentTextId);
    await loadInteractiveText(text.content, currentTextId);
  } catch (error) {
    console.error("Failed to refresh text:", error);
  }
}

// Look up a term and display in the sidebar
async function lookupInSidebar(term: string, termType: "character" | "word") {
  const sidebarContent = document.getElementById("dict-sidebar-content");
  if (!sidebarContent) return;

  sidebarContent.innerHTML = '<p class="loading">Looking up...</p>';

  try {
    const result = await dictionary.lookup(term, {
      includeExamples: true,
      includeCharacterInfo: termType === "character",
      includeUserDictionaries: true,
    });

    renderSidebarResults(result, termType, "dict-sidebar-content");
  } catch (error) {
    sidebarContent.innerHTML = `<p class="error">Lookup failed: ${error}</p>`;
  }
}

// Look up a term and display in the shelf sidebar
async function lookupInShelfSidebar(term: string, termType: "character" | "word") {
  const sidebarContent = document.getElementById("shelf-dict-sidebar-content");
  if (!sidebarContent) return;

  sidebarContent.innerHTML = '<p class="loading">Looking up...</p>';

  try {
    const result = await dictionary.lookup(term, {
      includeExamples: true,
      includeCharacterInfo: termType === "character",
      includeUserDictionaries: true,
    });

    renderSidebarResults(result, termType, "shelf-dict-sidebar-content");
  } catch (error) {
    sidebarContent.innerHTML = `<p class="error">Lookup failed: ${error}</p>`;
  }
}

// Render dictionary results in the sidebar
function renderSidebarResults(result: dictionary.LookupResult, termType: "character" | "word", containerId: string = "dict-sidebar-content") {
  const sidebarContent = document.getElementById(containerId);
  if (!sidebarContent) return;

  // Mark as known/learning buttons at the top
  let html = `
    <div class="dict-sidebar-actions-top">
      <button class="btn-primary btn-mark-known-sidebar" data-word="${escapeHtml(result.query)}" data-type="${termType}">
        Mark Known
      </button>
      <button class="btn-secondary btn-mark-learning-sidebar" data-word="${escapeHtml(result.query)}" data-type="${termType}">
        Mark Learning
      </button>
    </div>
  `;

  if (result.entries.length === 0 && result.user_entries.length === 0) {
    html += `<p class="dict-sidebar-empty">No dictionary entries found for "${result.query}"</p>`;
    sidebarContent.innerHTML = html;
    setupSidebarMarkKnown();
    return;
  }

  // Character info (compact)
  if (result.character_info) {
    const char = result.character_info;
    html += `
      <div class="entry">
        <div class="entry-header">
          <span class="traditional" style="font-size: 2rem;">${char.character}</span>
        </div>
        <div style="font-size: 0.85rem; color: #888; margin-top: 0.5rem;">
          ${char.radical ? `Radical: ${char.radical} (#${char.radical_number})` : ""}
          ${char.total_strokes ? ` · ${char.total_strokes} strokes` : ""}
        </div>
      </div>
    `;
  }

  // Dictionary entries (compact)
  for (const entry of result.entries.slice(0, 5)) {
    html += `
      <div class="entry">
        <div class="entry-header">
          <span class="traditional">${entry.traditional}</span>
          ${entry.simplified !== entry.traditional ? `<span class="simplified">(${entry.simplified})</span>` : ""}
          <span class="pinyin">${dictionary.formatPinyin(entry)}</span>
        </div>
        <div class="definitions">
          ${entry.definitions.slice(0, 3)
            .map(def => `
              <div class="definition">
                ${def.part_of_speech ? `<span class="pos">${def.part_of_speech}</span>` : ""}
                <span class="def-text">${def.text}</span>
              </div>
            `)
            .join("")}
        </div>
      </div>
    `;
  }

  // User entries
  for (const entry of result.user_entries.slice(0, 3)) {
    html += `
      <div class="entry user-entry">
        <div class="entry-header">
          <span class="traditional">${entry.term}</span>
          ${entry.pinyin ? `<span class="pinyin">${entry.pinyin}</span>` : ""}
        </div>
        <div class="definitions">
          <div class="definition">
            <span class="def-text">${entry.definition}</span>
          </div>
        </div>
      </div>
    `;
  }

  sidebarContent.innerHTML = html;
  setupSidebarMarkKnown();
}

// Set up mark known/learning buttons in sidebar
function setupSidebarMarkKnown() {
  // Handle "Mark Known" button
  document.querySelectorAll(".btn-mark-known-sidebar").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const word = (btn as HTMLElement).dataset.word!;
      const wordType = (btn as HTMLElement).dataset.type!;

      // Optimistic UI update
      (btn as HTMLButtonElement).textContent = "Marked as Known!";
      (btn as HTMLButtonElement).disabled = true;

      // Disable the learning button too
      const learningBtn = btn.parentElement?.querySelector(".btn-mark-learning-sidebar") as HTMLButtonElement;
      if (learningBtn) learningBtn.disabled = true;

      try {
        await library.addKnownWord(word, wordType, "known");

        // Update the text segment to remove unknown/learning highlighting
        document.querySelectorAll(`.text-segment[data-text="${word}"]`).forEach(el => {
          el.classList.remove("unknown", "learning");
        });

        // Update any analysis freq-items for this word
        document.querySelectorAll(`.freq-item[data-lookup="${word}"]`).forEach(el => {
          el.classList.remove("unknown");
          el.classList.add("known");
          // Replace the mark known button with known badge if present
          const itemBtn = el.querySelector(".btn-mark-known, .btn-mark-known-shelf");
          if (itemBtn) {
            itemBtn.outerHTML = '<span class="known-badge">Known</span>';
          }
        });
      } catch (error) {
        console.error("Failed to mark as known:", error);
        // Revert UI on error
        (btn as HTMLButtonElement).textContent = "Mark Known";
        (btn as HTMLButtonElement).disabled = false;
        if (learningBtn) learningBtn.disabled = false;
      }
    });
  });

  // Handle "Mark Learning" button
  document.querySelectorAll(".btn-mark-learning-sidebar").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const word = (btn as HTMLElement).dataset.word!;
      const wordType = (btn as HTMLElement).dataset.type!;

      // Optimistic UI update
      (btn as HTMLButtonElement).textContent = "Marked as Learning!";
      (btn as HTMLButtonElement).disabled = true;

      // Disable the known button too
      const knownBtn = btn.parentElement?.querySelector(".btn-mark-known-sidebar") as HTMLButtonElement;
      if (knownBtn) knownBtn.disabled = true;

      try {
        await library.addKnownWord(word, wordType, "learning");

        // Update the text segment to show learning highlighting (yellow instead of red)
        document.querySelectorAll(`.text-segment[data-text="${word}"]`).forEach(el => {
          el.classList.remove("unknown");
          el.classList.add("learning");
        });

        // Update any analysis freq-items for this word (still counts as unknown for analysis)
        document.querySelectorAll(`.freq-item[data-lookup="${word}"]`).forEach(el => {
          el.classList.add("learning");
          // Replace the mark button with learning badge if present
          const itemBtn = el.querySelector(".btn-mark-known, .btn-mark-known-shelf");
          if (itemBtn) {
            itemBtn.outerHTML = '<span class="learning-badge">Learning</span>';
          }
        });
      } catch (error) {
        console.error("Failed to mark as learning:", error);
        // Revert UI on error
        (btn as HTMLButtonElement).textContent = "Mark Learning";
        (btn as HTMLButtonElement).disabled = false;
        if (knownBtn) knownBtn.disabled = false;
      }
    });
  });
}

// Track current sort mode
let currentSort: library.FrequencySort = "text_frequency";

async function loadAnalysis(textId: number, sort: library.FrequencySort = currentSort) {
  const container = document.getElementById("analysis-container");
  if (!container) return;

  currentSort = sort;

  try {
    const report = await library.getAnalysisReport(textId, 20, sort);

    // Use occurrence counts from the summary for accurate rates
    const knownCharRate = report.summary.total_characters > 0
      ? Math.round((report.summary.known_character_occurrences / report.summary.total_characters) * 100)
      : 100;
    const knownWordRate = report.summary.total_words > 0
      ? Math.round((report.summary.known_word_occurrences / report.summary.total_words) * 100)
      : 100;

    const formatFreqItem = (item: library.CharacterFrequency | library.WordFrequency, type: "character" | "word") => {
      const label = type === "character" ? (item as library.CharacterFrequency).character : (item as library.WordFrequency).word;
      const rankDisplay = item.general_frequency_rank !== null
        ? `<span class="freq-rank" title="General frequency rank">#${item.general_frequency_rank}</span>`
        : "";
      return `
        <div class="freq-item ${item.is_known ? "known" : "unknown"}" data-lookup="${escapeHtml(label)}" data-lookup-type="${type}">
          <span class="freq-${type === "character" ? "char" : "word"} freq-clickable">${label}</span>
          <span class="freq-count">${item.frequency}x</span>
          ${rankDisplay}
          ${!item.is_known
            ? `<button class="btn-mark-known" data-word="${label}" data-type="${type}">Mark Known</button>`
            : '<span class="known-badge">Known</span>'
          }
        </div>
      `;
    };

    let html = `
      <div class="analysis-summary">
        <div class="stat-card">
          <span class="stat-value">${report.summary.total_characters}</span>
          <span class="stat-label">Total Characters</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${report.summary.unique_characters}</span>
          <span class="stat-label">Unique Characters</span>
        </div>
        <div class="stat-card ${knownCharRate >= 98 ? "highlight-good" : knownCharRate < 90 ? "highlight-bad" : ""}">
          <span class="stat-value">${knownCharRate}%</span>
          <span class="stat-label">Known Char Rate</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${report.summary.total_words}</span>
          <span class="stat-label">Total Words</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${report.summary.unique_words}</span>
          <span class="stat-label">Unique Words</span>
        </div>
        <div class="stat-card ${knownWordRate >= 98 ? "highlight-good" : knownWordRate < 90 ? "highlight-bad" : ""}">
          <span class="stat-value">${knownWordRate}%</span>
          <span class="stat-label">Known Word Rate</span>
        </div>
      </div>

      <div class="sort-controls">
        <span>Sort by:</span>
        <button class="sort-btn ${sort === "text_frequency" ? "active" : ""}" data-sort="text_frequency">Text Frequency</button>
        <button class="sort-btn ${sort === "general_frequency" ? "active" : ""}" data-sort="general_frequency">General Frequency</button>
      </div>

      <div class="analysis-sections">
        <div class="analysis-section">
          <h3>Unknown Characters (${report.unknown_characters.length})</h3>
          <div class="freq-list">
            ${
              report.unknown_characters.length === 0
                ? '<p class="empty-message">All characters are known!</p>'
                : report.unknown_characters.map(cf => formatFreqItem(cf, "character")).join("")
            }
          </div>
        </div>

        <div class="analysis-section">
          <h3>Known Characters (${report.known_characters.length})</h3>
          <div class="freq-list">
            ${
              report.known_characters.length === 0
                ? '<p class="empty-message">No known characters yet.</p>'
                : report.known_characters.map(cf => formatFreqItem(cf, "character")).join("")
            }
          </div>
        </div>

        <div class="analysis-section">
          <h3>Unknown Words (${report.unknown_words.length})</h3>
          <div class="freq-list">
            ${
              report.unknown_words.length === 0
                ? '<p class="empty-message">All words are known!</p>'
                : report.unknown_words.map(wf => formatFreqItem(wf, "word")).join("")
            }
          </div>
        </div>

        <div class="analysis-section">
          <h3>Known Words (${report.known_words_list.length})</h3>
          <div class="freq-list">
            ${
              report.known_words_list.length === 0
                ? '<p class="empty-message">No known words yet.</p>'
                : report.known_words_list.map(wf => formatFreqItem(wf, "word")).join("")
            }
          </div>
        </div>
      </div>
    `;

    container.innerHTML = html;

    // Add sort button handlers
    container.querySelectorAll(".sort-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const newSort = (btn as HTMLElement).dataset.sort as library.FrequencySort;
        loadAnalysis(textId, newSort);
      });
    });

    // Add mark known handlers - optimistic UI update
    container.querySelectorAll(".btn-mark-known").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const word = (btn as HTMLElement).dataset.word!;
        const wordType = (btn as HTMLElement).dataset.type!;
        const freqItem = (btn as HTMLElement).closest(".freq-item");

        // Optimistic UI update - immediately update the button
        (btn as HTMLButtonElement).textContent = "Marked!";
        (btn as HTMLButtonElement).disabled = true;
        freqItem?.classList.remove("unknown");
        freqItem?.classList.add("known");

        try {
          await library.addKnownWord(word, wordType);
          // Replace button with known badge
          btn.outerHTML = '<span class="known-badge">Known</span>';

          // Also update the text content view if visible
          document.querySelectorAll(`.text-segment[data-text="${word}"]`).forEach(el => {
            el.classList.remove("unknown");
          });
        } catch (error) {
          console.error("Failed to mark as known:", error);
          // Revert UI on error
          (btn as HTMLButtonElement).textContent = "Mark Known";
          (btn as HTMLButtonElement).disabled = false;
          freqItem?.classList.add("unknown");
          freqItem?.classList.remove("known");
        }
      });
    });

    // Add click handlers for dictionary lookup
    container.querySelectorAll(".freq-item[data-lookup]").forEach((item) => {
      item.addEventListener("click", (e) => {
        // Don't trigger if clicking the button
        if ((e.target as HTMLElement).closest(".btn-mark-known")) return;

        const term = (item as HTMLElement).dataset.lookup!;
        const termType = (item as HTMLElement).dataset.lookupType as "character" | "word";

        // Highlight selected item
        container.querySelectorAll(".freq-item").forEach(el => el.classList.remove("selected"));
        item.classList.add("selected");

        lookupInSidebar(term, termType);
      });
    });
  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load analysis: ${error}</p>`;
  }
}

function renderLibraryWelcome() {
  const mainContainer = document.getElementById("library-main");
  if (!mainContainer) return;

  mainContainer.innerHTML = `
    <div class="library-welcome">
      <h2>Welcome to Your Library</h2>
      <p>Select a shelf from the sidebar to view its texts, or create a new shelf to get started.</p>
      <div class="welcome-tips">
        <div class="tip">
          <h4>Organize with Shelves</h4>
          <p>Create hierarchical shelves to organize your reading materials.</p>
        </div>
        <div class="tip">
          <h4>Import Texts</h4>
          <p>Paste text or import files to build your reading collection.</p>
        </div>
        <div class="tip">
          <h4>Analyze Content</h4>
          <p>See character and word frequencies, track your vocabulary progress.</p>
        </div>
      </div>
    </div>
  `;
}

// =============================================================================
// Speed View
// =============================================================================

let currentSpeedShelfId: number | null = null;
let currentGraphType: "cumulative" | "known_chars" | "known_words" = "cumulative";
let excludeHighAutoMarked: boolean = false;

async function loadSpeedView() {
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

    const shelfOptions = renderSpeedShelfOptions(shelves);

    let html = `
      <div class="speed-view">
        <div class="speed-header">
          <h2>Reading Speed</h2>
          <div class="speed-filter">
            <label for="speed-shelf-filter">Scope:</label>
            <select id="speed-shelf-filter">
              <option value="">Global (All Shelves)</option>
              ${shelfOptions}
            </select>
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

    // Set up event handlers
    setupSpeedViewHandlers(data);

  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load speed data: ${error}</p>`;
  }
}

function renderSpeedShelfOptions(shelves: library.ShelfTree[], depth: number = 0): string {
  return shelves
    .map((node) => {
      const indent = "—".repeat(depth);
      const selected = node.shelf.id === currentSpeedShelfId ? "selected" : "";
      return `
        <option value="${node.shelf.id}" ${selected}>${indent}${escapeHtml(node.shelf.name)}</option>
        ${renderSpeedShelfOptions(node.children, depth + 1)}
      `;
    })
    .join("");
}

function renderSpeedGraph(data: speed.SpeedDataPoint[], graphType: "cumulative" | "known_chars" | "known_words"): string {
  // For knowledge correlation graphs, optionally filter out high auto-marked sessions
  let filteredData = data;
  if (excludeHighAutoMarked && (graphType === "known_chars" || graphType === "known_words")) {
    filteredData = speed.filterHighAutoMarked(data);
  }

  if (filteredData.length === 0) {
    const filterNote = excludeHighAutoMarked && data.length > 0
      ? " (all sessions excluded due to high auto-mark filter)"
      : "";
    return `<p class="empty-message graph-empty">No reading sessions yet${filterNote}. Start reading to see your progress!</p>`;
  }

  // Calculate graph dimensions
  const graphHeight = 300; // pixels

  // Determine X and Y values based on graph type
  const points = filteredData.map((d) => {
    let x: number;
    let xLabel: string;

    switch (graphType) {
      case "cumulative":
        x = d.cumulative_characters_read;
        xLabel = `${library.formatCharacterCount(d.cumulative_characters_read)} chars read`;
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

  // Calculate min/max for scaling
  const xValues = points.map((p) => p.x);
  const yValues = points.map((p) => p.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues) * 0.9;
  const maxY = Math.max(...yValues) * 1.1;

  const xRange = maxX - minX || 1;
  const yRange = maxY - minY || 1;

  // Generate scatter plot points
  const pointsHtml = points
    .map((p, i) => {
      const xPercent = ((p.x - minX) / xRange) * 90 + 5; // 5-95% range
      const yPercent = 100 - ((p.y - minY) / yRange) * 90 - 5; // inverted, 5-95% range

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

  // X-axis labels
  const xAxisLabel = graphType === "cumulative"
    ? "Characters Read"
    : graphType === "known_chars"
      ? "Known Characters"
      : "Known Words";

  return `
    <div class="graph-container" style="height: ${graphHeight}px;">
      <div class="graph-y-axis">
        <span class="axis-label">${Math.round(maxY)}</span>
        <span class="axis-label">${Math.round((maxY + minY) / 2)}</span>
        <span class="axis-label">${Math.round(minY)}</span>
      </div>
      <div class="graph-plot-area">
        ${pointsHtml}
      </div>
      <div class="graph-y-label">chars/min</div>
    </div>
    <div class="graph-x-axis">
      <span class="axis-label">${library.formatCharacterCount(Math.round(minX))}</span>
      <span class="axis-label graph-x-label">${xAxisLabel}</span>
      <span class="axis-label">${library.formatCharacterCount(Math.round(maxX))}</span>
    </div>
  `;
}

function renderRecentSessions(data: speed.SpeedDataPoint[]): string {
  if (data.length === 0) {
    return '<p class="empty-message">No completed reading sessions yet.</p>';
  }

  // Show most recent first (reverse since data is sorted by finished_at ascending)
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
  // Shelf filter
  document.getElementById("speed-shelf-filter")?.addEventListener("change", async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    currentSpeedShelfId = value ? parseInt(value) : null;
    await loadSpeedView();
  });

  // Graph tabs
  document.querySelectorAll(".graph-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const graphType = (tab as HTMLElement).dataset.graph as "cumulative" | "known_chars" | "known_words";
      currentGraphType = graphType;

      // Update active tab
      document.querySelectorAll(".graph-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      // Re-render graph
      const graphContainer = document.getElementById("speed-graph");
      if (graphContainer) {
        graphContainer.innerHTML = renderSpeedGraph(data, graphType);
      }
    });
  });

  // Auto-mark toggle
  document.getElementById("auto-mark-toggle")?.addEventListener("change", async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    try {
      await library.setAutoMarkEnabled(enabled);
    } catch (error) {
      console.error("Failed to update auto-mark setting:", error);
      // Revert the toggle on error
      (e.target as HTMLInputElement).checked = !enabled;
    }
  });

  // Exclude high auto-marked toggle
  document.getElementById("exclude-high-automark-toggle")?.addEventListener("change", (e) => {
    excludeHighAutoMarked = (e.target as HTMLInputElement).checked;

    // Re-render graph with new filter setting
    const graphContainer = document.getElementById("speed-graph");
    if (graphContainer) {
      graphContainer.innerHTML = renderSpeedGraph(data, currentGraphType);
    }
  });
}

// =============================================================================
// Learning View
// =============================================================================

let currentLearningSource: string | null = null;
let currentLearningTab: "characters" | "words" = "characters";

async function loadLearningView() {
  const container = document.getElementById("learning-main");
  if (!container) return;

  container.innerHTML = '<p class="loading">Loading learning data...</p>';

  try {
    // Record vocabulary snapshot on view load
    await learning.recordVocabularySnapshot();

    const [sources, stats, progress] = await Promise.all([
      learning.listFrequencySources(),
      learning.getLearningStats(currentLearningSource ?? undefined),
      learning.getVocabularyProgress(30),
    ]);

    // Determine the default source if none selected
    if (!currentLearningSource && sources.length > 0) {
      // Try to find a source that ends with _character, or use the first one
      const charSource = sources.find((s) => s.name.includes("character"));
      currentLearningSource = charSource ? charSource.name.split("_")[0] : sources[0].name.split("_")[0];
    }

    // Group sources by base name (without _character/_word suffix)
    const uniqueSources = [...new Set(sources.map((s) => s.name.split("_")[0]))];

    let html = `
      <div class="learning-view">
        <div class="learning-header">
          <h2>Learning Progress</h2>
          ${sources.length > 0 ? `
            <div class="learning-source-filter">
              <label for="learning-source-select">Frequency Source:</label>
              <select id="learning-source-select">
                ${uniqueSources.map((src) => `
                  <option value="${src}" ${src === currentLearningSource ? "selected" : ""}>
                    ${learning.getSourceDisplayName(src)}
                  </option>
                `).join("")}
              </select>
            </div>
          ` : ""}
        </div>

        <div class="learning-stats">
          <div class="stat-card">
            <span class="stat-value">${stats.total_known_characters}</span>
            <span class="stat-label">Known Characters</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${stats.total_learning_characters}</span>
            <span class="stat-label">Learning Characters</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${stats.total_known_words}</span>
            <span class="stat-label">Known Words</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${stats.total_learning_words}</span>
            <span class="stat-label">Learning Words</span>
          </div>
        </div>
    `;

    // Percentile coverage section
    if (sources.length > 0 && (stats.character_coverage.length > 0 || stats.word_coverage.length > 0)) {
      html += `
        <div class="percentile-section">
          <h3>Frequency Coverage</h3>
          <p class="section-description">How much of the most common vocabulary do you know?</p>

          <div class="coverage-tabs">
            <button class="coverage-tab ${currentLearningTab === "characters" ? "active" : ""}" data-tab="characters">
              Characters
            </button>
            <button class="coverage-tab ${currentLearningTab === "words" ? "active" : ""}" data-tab="words">
              Words
            </button>
          </div>

          <div class="coverage-content">
            ${renderPercentileCoverage(
              currentLearningTab === "characters" ? stats.character_coverage : stats.word_coverage
            )}
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="percentile-section empty-state">
          <h3>Frequency Coverage</h3>
          <p class="empty-message">
            No frequency data loaded yet. Import word frequency data to see your coverage of common vocabulary.
          </p>
          <button id="import-frequency-btn" class="btn-primary">Import Frequency Data</button>
        </div>
      `;
    }

    // Vocabulary progress over time
    html += `
      <div class="progress-section">
        <h3>Vocabulary Growth</h3>
        ${renderVocabularyProgress(progress)}
      </div>
    `;

    // Study priorities
    if (sources.length > 0 && currentLearningSource) {
      try {
        const priorities = await learning.getStudyPriorities(currentLearningSource, undefined, 20);
        html += `
          <div class="priorities-section">
            <h3>Study Priorities</h3>
            <p class="section-description">High-frequency terms you don't know yet</p>
            ${renderStudyPriorities(priorities)}
          </div>
        `;
      } catch {
        // Ignore errors in study priorities
      }
    }

    html += `</div>`;

    container.innerHTML = html;

    // Set up event handlers
    setupLearningViewHandlers(stats);
  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load learning data: ${error}</p>`;
  }
}

function renderPercentileCoverage(coverage: learning.PercentileCoverage[]): string {
  if (coverage.length === 0) {
    return '<p class="empty-message">No coverage data available for this source.</p>';
  }

  let html = '<div class="coverage-bars">';

  for (const item of coverage) {
    const coverageClass = learning.getCoverageColorClass(item.coverage_percent);

    html += `
      <div class="coverage-row">
        <div class="coverage-label">
          <span class="percentile-label">Top ${item.percentile}%</span>
          <span class="terms-count">${item.total_terms.toLocaleString()} terms</span>
        </div>
        <div class="coverage-bar-container">
          <div class="coverage-bar ${coverageClass}" style="width: ${item.coverage_percent}%">
            <span class="coverage-known">${item.known_terms.toLocaleString()} known</span>
          </div>
          ${item.learning_terms > 0 ? `
            <div class="coverage-bar learning" style="width: ${(item.learning_terms / item.total_terms) * 100}%">
            </div>
          ` : ""}
        </div>
        <div class="coverage-percent ${coverageClass}">
          ${learning.formatCoveragePercent(item.coverage_percent)}
        </div>
      </div>
    `;
  }

  html += '</div>';
  return html;
}

function renderVocabularyProgress(progress: learning.VocabularyProgress[]): string {
  if (progress.length === 0) {
    return '<p class="empty-message">No progress data yet. Keep learning!</p>';
  }

  // Show as a simple table for now
  let html = `
    <div class="progress-table-container">
      <table class="progress-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Known Chars</th>
            <th>Known Words</th>
            <th>Learning</th>
          </tr>
        </thead>
        <tbody>
  `;

  // Show recent entries (reversed to show newest first)
  const recentProgress = [...progress].reverse().slice(0, 10);

  for (let i = 0; i < recentProgress.length; i++) {
    const item = recentProgress[i];
    const prev = recentProgress[i + 1] || null;
    const diff = learning.calculateProgressDiff(item, prev);

    html += `
      <tr>
        <td>${formatProgressDate(item.date)}</td>
        <td>
          ${item.known_characters.toLocaleString()}
          ${diff.charsDiff > 0 ? `<span class="diff-positive">+${diff.charsDiff}</span>` : ""}
        </td>
        <td>
          ${item.known_words.toLocaleString()}
          ${diff.wordsDiff > 0 ? `<span class="diff-positive">+${diff.wordsDiff}</span>` : ""}
        </td>
        <td class="learning-count">
          ${item.learning_characters + item.learning_words}
        </td>
      </tr>
    `;
  }

  html += `
        </tbody>
      </table>
    </div>
  `;

  return html;
}

function renderStudyPriorities(priorities: learning.TermFrequencyInfo[]): string {
  if (priorities.length === 0) {
    return '<p class="empty-message">No study priorities found. Great job!</p>';
  }

  let html = '<div class="priorities-list">';

  for (const item of priorities) {
    const statusClass = item.is_learning ? "learning" : "unknown";
    const statusBadge = item.is_learning ? '<span class="learning-badge">Learning</span>' : "";

    html += `
      <div class="priority-item ${statusClass}" data-term="${escapeHtml(item.term)}" data-type="${item.term_type}">
        <span class="priority-term">${item.term}</span>
        <span class="priority-type">${item.term_type}</span>
        ${item.rank ? `<span class="priority-rank">#${item.rank.toLocaleString()}</span>` : ""}
        ${statusBadge}
        <button class="btn-mark-known-priority" data-word="${escapeHtml(item.term)}" data-type="${item.term_type}">
          Mark Known
        </button>
      </div>
    `;
  }

  html += '</div>';
  return html;
}

function formatProgressDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function setupLearningViewHandlers(stats: learning.LearningStats) {
  // Source selector
  document.getElementById("learning-source-select")?.addEventListener("change", async (e) => {
    currentLearningSource = (e.target as HTMLSelectElement).value;
    await loadLearningView();
  });

  // Coverage tabs
  document.querySelectorAll(".coverage-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      currentLearningTab = (tab as HTMLElement).dataset.tab as "characters" | "words";

      // Update active tab
      document.querySelectorAll(".coverage-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      // Update coverage content
      const contentDiv = document.querySelector(".coverage-content");
      if (contentDiv) {
        const coverage = currentLearningTab === "characters"
          ? stats.character_coverage
          : stats.word_coverage;
        contentDiv.innerHTML = renderPercentileCoverage(coverage);
      }
    });
  });

  // Import frequency button
  document.getElementById("import-frequency-btn")?.addEventListener("click", showImportFrequencyModal);

  // Mark known buttons in priorities
  document.querySelectorAll(".btn-mark-known-priority").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const word = (btn as HTMLElement).dataset.word!;
      const wordType = (btn as HTMLElement).dataset.type!;
      const item = (btn as HTMLElement).closest(".priority-item");

      // Optimistic UI update
      (btn as HTMLButtonElement).textContent = "Marked!";
      (btn as HTMLButtonElement).disabled = true;

      try {
        await library.addKnownWord(word, wordType, "known");
        // Remove the item from the list
        item?.remove();
      } catch (error) {
        console.error("Failed to mark as known:", error);
        (btn as HTMLButtonElement).textContent = "Mark Known";
        (btn as HTMLButtonElement).disabled = false;
      }
    });
  });

  // Priority item click for dictionary lookup
  document.querySelectorAll(".priority-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".btn-mark-known-priority")) return;

      const term = (item as HTMLElement).dataset.term!;
      // Switch to dictionary tab and search
      const searchInput = document.getElementById("search-input") as HTMLInputElement;
      if (searchInput) {
        searchInput.value = term;
        document.querySelector('[data-view="dictionary"]')?.dispatchEvent(new Event("click"));
        document.getElementById("search-btn")?.click();
      }
    });
  });
}

function showImportFrequencyModal() {
  const modal = createModal("Import Frequency Data", `
    <form id="import-frequency-form">
      <div class="form-group">
        <label for="freq-source">Source Name</label>
        <input type="text" id="freq-source" required placeholder="e.g., books, movies, internet" />
      </div>
      <div class="form-group">
        <label for="freq-type">Term Type</label>
        <select id="freq-type" required>
          <option value="character">Characters</option>
          <option value="word">Words</option>
        </select>
      </div>
      <div class="form-group">
        <label for="freq-content">Data (tab-separated: term, rank, count)</label>
        <textarea id="freq-content" required rows="10" placeholder="我&#9;1&#9;1000000&#10;你&#9;2&#9;900000&#10;..."></textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-secondary modal-cancel">Cancel</button>
        <button type="submit" class="btn-primary">Import</button>
      </div>
    </form>
  `);

  const form = modal.querySelector("#import-frequency-form") as HTMLFormElement;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const source = (document.getElementById("freq-source") as HTMLInputElement).value;
    const termType = (document.getElementById("freq-type") as HTMLSelectElement).value;
    const content = (document.getElementById("freq-content") as HTMLTextAreaElement).value;

    try {
      const stats = await learning.importFrequencyData(content, source, termType);
      alert(`Imported ${stats.terms_imported} terms (${stats.terms_skipped} skipped, ${stats.errors} errors)`);
      closeModal();
      currentLearningSource = source;
      await loadLearningView();
    } catch (error) {
      alert(`Failed to import: ${error}`);
    }
  });
}

// =============================================================================
// Modals
// =============================================================================

function showAddShelfModal() {
  const modal = createModal("Add Shelf", `
    <form id="add-shelf-form">
      <div class="form-group">
        <label for="shelf-name">Name</label>
        <input type="text" id="shelf-name" required placeholder="e.g., Classic Literature" />
      </div>
      <div class="form-group">
        <label for="shelf-description">Description (optional)</label>
        <textarea id="shelf-description" placeholder="Description of this shelf..."></textarea>
      </div>
      <div class="form-group">
        <label for="shelf-parent">Parent Shelf (optional)</label>
        <select id="shelf-parent">
          <option value="">None (root level)</option>
          ${renderShelfOptions(shelfTree, 0)}
        </select>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-secondary modal-cancel">Cancel</button>
        <button type="submit" class="btn-primary">Create</button>
      </div>
    </form>
  `);

  const form = modal.querySelector("#add-shelf-form") as HTMLFormElement;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const name = (document.getElementById("shelf-name") as HTMLInputElement).value;
    const description = (document.getElementById("shelf-description") as HTMLTextAreaElement).value || undefined;
    const parentId = (document.getElementById("shelf-parent") as HTMLSelectElement).value;

    try {
      await library.createShelf(name, description, parentId ? parseInt(parentId) : undefined);
      closeModal();
      await loadShelfTree();
    } catch (error) {
      alert(`Failed to create shelf: ${error}`);
    }
  });
}

function showEditShelfModal(shelfId: number) {
  const shelfNode = findShelfById(shelfTree, shelfId);
  if (!shelfNode) return;

  const shelf = shelfNode.shelf;

  const modal = createModal("Edit Shelf", `
    <form id="edit-shelf-form">
      <div class="form-group">
        <label for="shelf-name">Name</label>
        <input type="text" id="shelf-name" required value="${escapeHtml(shelf.name)}" />
      </div>
      <div class="form-group">
        <label for="shelf-description">Description</label>
        <textarea id="shelf-description">${escapeHtml(shelf.description || "")}</textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-secondary modal-cancel">Cancel</button>
        <button type="submit" class="btn-primary">Save</button>
      </div>
    </form>
  `);

  const form = modal.querySelector("#edit-shelf-form") as HTMLFormElement;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const name = (document.getElementById("shelf-name") as HTMLInputElement).value;
    const description = (document.getElementById("shelf-description") as HTMLTextAreaElement).value;

    try {
      await library.updateShelf(shelfId, { name, description });
      closeModal();
      await loadShelfTree();
    } catch (error) {
      alert(`Failed to update shelf: ${error}`);
    }
  });
}

function showMoveShelfModal(shelfId: number) {
  const shelfNode = findShelfById(shelfTree, shelfId);
  if (!shelfNode) return;

  const shelf = shelfNode.shelf;

  // Build options excluding the shelf itself and its descendants
  const excludeIds = getShelfAndDescendantIds(shelfTree, shelfId);
  const shelfOptions = renderShelfOptionsExcluding(shelfTree, 0, excludeIds, shelf.parent_id);

  const modal = createModal("Move Shelf", `
    <form id="move-shelf-form">
      <div class="form-group">
        <p>Move <strong>${escapeHtml(shelf.name)}</strong> to:</p>
      </div>
      <div class="form-group">
        <label for="new-parent-shelf">New Parent Shelf</label>
        <select id="new-parent-shelf">
          <option value="">None (root level)</option>
          ${shelfOptions}
        </select>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-secondary modal-cancel">Cancel</button>
        <button type="submit" class="btn-primary">Move</button>
      </div>
    </form>
  `);

  const form = modal.querySelector("#move-shelf-form") as HTMLFormElement;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const newParentIdStr = (document.getElementById("new-parent-shelf") as HTMLSelectElement).value;
    const newParentId = newParentIdStr ? parseInt(newParentIdStr) : undefined;

    // Don't move if the parent hasn't changed
    if (newParentId === shelf.parent_id) {
      closeModal();
      return;
    }

    try {
      await library.moveShelf(shelfId, newParentId);
      closeModal();
      await loadShelfTree();
    } catch (error) {
      alert(`Failed to move shelf: ${error}`);
    }
  });
}

// Get IDs of a shelf and all its descendants (to exclude from move target)
function getShelfAndDescendantIds(tree: library.ShelfTree[], shelfId: number): Set<number> {
  const ids = new Set<number>();

  function collectIds(nodes: library.ShelfTree[]) {
    for (const node of nodes) {
      ids.add(node.shelf.id);
      collectIds(node.children);
    }
  }

  function findAndCollect(nodes: library.ShelfTree[]): boolean {
    for (const node of nodes) {
      if (node.shelf.id === shelfId) {
        ids.add(node.shelf.id);
        collectIds(node.children);
        return true;
      }
      if (findAndCollect(node.children)) return true;
    }
    return false;
  }

  findAndCollect(tree);
  return ids;
}

// Render shelf options excluding certain IDs
function renderShelfOptionsExcluding(
  nodes: library.ShelfTree[],
  depth: number,
  excludeIds: Set<number>,
  currentParentId: number | null
): string {
  return nodes
    .filter(node => !excludeIds.has(node.shelf.id))
    .map((node) => {
      const indent = "—".repeat(depth);
      const selected = node.shelf.id === currentParentId ? "selected" : "";
      return `
        <option value="${node.shelf.id}" ${selected}>${indent}${escapeHtml(node.shelf.name)}</option>
        ${renderShelfOptionsExcluding(node.children, depth + 1, excludeIds, currentParentId)}
      `;
    })
    .join("");
}

function showAddTextModal(shelfId: number) {
  const modal = createModal("Add Text", `
    <form id="add-text-form">
      <div class="form-group">
        <label for="text-title">Title</label>
        <input type="text" id="text-title" required placeholder="Text title" />
      </div>
      <div class="form-group">
        <label for="text-author">Author (optional)</label>
        <input type="text" id="text-author" placeholder="Author name" />
      </div>
      <div class="form-group">
        <label for="text-content">Content</label>
        <textarea id="text-content" required rows="10" placeholder="Paste Chinese text here..."></textarea>
      </div>
      <div class="form-group form-checkbox">
        <label>
          <input type="checkbox" id="convert-traditional" checked />
          Convert simplified to traditional characters
        </label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-secondary modal-cancel">Cancel</button>
        <button type="submit" class="btn-primary">Add</button>
      </div>
    </form>
  `);

  const form = modal.querySelector("#add-text-form") as HTMLFormElement;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const title = (document.getElementById("text-title") as HTMLInputElement).value;
    const author = (document.getElementById("text-author") as HTMLInputElement).value || undefined;
    const content = (document.getElementById("text-content") as HTMLTextAreaElement).value;
    const convertToTraditional = (document.getElementById("convert-traditional") as HTMLInputElement).checked;

    try {
      const result = await library.createText(shelfId, title, content, author, "paste", convertToTraditional);
      closeModal();

      // If the text was split, refresh the whole tree and show a message
      if (result.section_count > 1) {
        await loadShelfTree();
        alert(`Text was split into ${result.section_count} sections (each ~1500 characters) in a new shelf.`);
      }

      await loadTextsInShelf(shelfId);
    } catch (error) {
      alert(`Failed to add text: ${error}`);
    }
  });
}

async function confirmDeleteShelf(shelfId: number) {
  const confirmed = await confirm("Are you sure you want to delete this shelf? All texts and child shelves will be deleted.");
  if (!confirmed) {
    return;
  }

  try {
    await library.deleteShelf(shelfId);
    selectedShelfId = null;
    await loadShelfTree();
    renderLibraryWelcome();
  } catch (error) {
    alert(`Failed to delete shelf: ${error}`);
  }
}

async function splitLargeTextsInShelf(shelfId: number) {
  const confirmed = await confirm("This will split all texts over 1500 characters in this shelf (and sub-shelves) into smaller sections. Each large text will become a shelf containing section texts. Continue?");
  if (!confirmed) {
    return;
  }

  try {
    const result = await library.migrateLargeTexts(shelfId);

    if (result.texts_migrated === 0) {
      alert("No large texts found to split.");
    } else {
      alert(`Split ${result.texts_migrated} text(s) into ${result.sections_created} sections across ${result.shelves_created} new shelf(ves).`);
      await loadShelfTree();
      await loadTextsInShelf(shelfId);
    }
  } catch (error) {
    alert(`Failed to split texts: ${error}`);
  }
}

async function confirmDeleteText(textId: number) {
  const confirmed = await confirm("Are you sure you want to delete this text?");
  if (!confirmed) {
    return;
  }

  try {
    await library.deleteText(textId);
    if (selectedShelfId) {
      await loadTextsInShelf(selectedShelfId);
    }
  } catch (error) {
    alert(`Failed to delete text: ${error}`);
  }
}

function createModal(title: string, content: string): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        ${content}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Close handlers
  overlay.querySelector(".modal-close")?.addEventListener("click", closeModal);
  overlay.querySelector(".modal-cancel")?.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  return overlay;
}

function closeModal() {
  document.querySelector(".modal-overlay")?.remove();
}

// =============================================================================
// Helpers
// =============================================================================

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function findShelfById(nodes: library.ShelfTree[], id: number): library.ShelfTree | null {
  for (const node of nodes) {
    if (node.shelf.id === id) return node;
    const found = findShelfById(node.children, id);
    if (found) return found;
  }
  return null;
}

function renderShelfOptions(nodes: library.ShelfTree[], depth: number): string {
  return nodes
    .map((node) => {
      const indent = "—".repeat(depth);
      return `
        <option value="${node.shelf.id}">${indent}${escapeHtml(node.shelf.name)}</option>
        ${renderShelfOptions(node.children, depth + 1)}
      `;
    })
    .join("");
}

// Initialize on DOM ready
document.addEventListener("DOMContentLoaded", initApp);

// Also try to init immediately if DOM is already ready
if (document.readyState !== "loading") {
  initApp();
}

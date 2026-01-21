import "./style.css";
import * as dictionary from "./lib/dictionary";

// Initialize the app
async function initApp() {
  const app = document.querySelector<HTMLDivElement>("#app")!;

  app.innerHTML = `
    <div class="container">
      <h1>Chinese Reader</h1>
      <p class="subtitle">A vocabulary tracking and reading comprehension assistant</p>

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
  `;

  // Set up event listeners
  const searchInput = document.getElementById(
    "search-input"
  ) as HTMLInputElement;
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

      displayResults(result);
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

  // Load and display stats
  await loadStats();
}

function displayResults(result: dictionary.LookupResult) {
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

// Initialize on DOM ready
document.addEventListener("DOMContentLoaded", initApp);

// Also try to init immediately if DOM is already ready
if (document.readyState !== "loading") {
  initApp();
}

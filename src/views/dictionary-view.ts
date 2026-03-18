import * as dictionary from "../lib/dictionary";
import { escapeHtml, createModal, closeModal } from "../utils";

// =============================================================================
// Dictionary View
// =============================================================================

export function setupDictionaryView() {
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
            <button class="btn-edit-user-entry" data-entry-id="${entry.id}" data-term="${escapeHtml(entry.term)}" data-pinyin="${escapeHtml(entry.pinyin || "")}" data-definition="${escapeHtml(entry.definition)}">Edit</button>
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

  // Attach edit button handlers for user entries
  resultsDiv.querySelectorAll(".btn-edit-user-entry").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const button = e.currentTarget as HTMLButtonElement;
      const entryId = parseInt(button.dataset.entryId || "0", 10);
      const term = button.dataset.term || "";
      const pinyin = button.dataset.pinyin || "";
      const definition = button.dataset.definition || "";
      showEditUserEntryModal(entryId, term, pinyin, definition);
    });
  });
}

export async function loadStats() {
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
  } catch (_error) {
    statsDiv.innerHTML = `<p class="stats-info">Dictionary stats unavailable</p>`;
  }
}

function showEditUserEntryModal(
  entryId: number,
  term: string,
  currentPinyin: string,
  currentDefinition: string
) {
  const formContent = `
    <form id="edit-user-entry-form">
      <div class="form-group">
        <label>Term</label>
        <input type="text" value="${escapeHtml(term)}" disabled class="form-input" />
      </div>
      <div class="form-group">
        <label for="edit-pinyin">Pinyin</label>
        <input type="text" id="edit-pinyin" value="${escapeHtml(currentPinyin)}" class="form-input" placeholder="e.g., nǐ hǎo" />
      </div>
      <div class="form-group">
        <label for="edit-definition">Definition</label>
        <textarea id="edit-definition" class="form-input" rows="4" required>${escapeHtml(currentDefinition)}</textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-secondary modal-cancel">Cancel</button>
        <button type="submit" class="btn-primary">Save</button>
      </div>
    </form>
  `;

  const overlay = createModal(`Edit: ${term}`, formContent);

  const form = overlay.querySelector("#edit-user-entry-form") as HTMLFormElement;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const pinyinInput = overlay.querySelector("#edit-pinyin") as HTMLInputElement;
    const definitionInput = overlay.querySelector("#edit-definition") as HTMLTextAreaElement;

    const newPinyin = pinyinInput.value.trim();
    const newDefinition = definitionInput.value.trim();

    if (!newDefinition) {
      alert("Definition is required.");
      return;
    }

    try {
      await dictionary.updateUserDictionaryEntry(entryId, {
        pinyin: newPinyin || undefined,
        definition: newDefinition,
      });
      closeModal();
      // Re-run the current search to refresh results
      const searchInput = document.getElementById("search-input") as HTMLInputElement;
      if (searchInput.value) {
        const searchBtn = document.getElementById("search-btn") as HTMLButtonElement;
        searchBtn.click();
      }
    } catch (err) {
      console.error("Failed to update entry:", err);
      alert("Failed to update entry. Please try again.");
    }
  });
}

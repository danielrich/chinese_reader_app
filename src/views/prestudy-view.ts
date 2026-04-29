import * as dictionary from "../lib/dictionary";
import * as library from "../lib/library";
import { escapeHtml, renderTwoLevelShelfSelector } from "../utils";

// =============================================================================
// Pre-Study View
// =============================================================================

let currentPrestudyShelfId: number | null = null;
let currentPrestudyPrimaryShelfId: number | null = null;
let currentPrestudyResult: library.PreStudyResult | null = null;
let currentPrestudyWordResult: library.PreStudyWordResult | null = null;
let currentPrestudyMode: "characters" | "words" = "characters";
let selectedPrestudyCharacter: string | null = null;
let selectedPrestudyWord: string | null = null;
let hideLearningCharacters: boolean = true;
let hideLearningWords: boolean = true;
let prestudyTargetRate: number = 90;

export async function loadPrestudyView() {
  const container = document.getElementById("prestudy-main");
  if (!container) return;

  try {
    const shelves = await library.getShelfTree();

    const html = `
      <div class="prestudy-view">
        <div class="prestudy-header">
          <h2>Pre-Study</h2>
          <p class="prestudy-description">
            Learn high-frequency characters or words before reading to improve comprehension.
            Select a shelf, set your target known rate, and calculate what to study.
          </p>
        </div>

        <div class="prestudy-mode-tabs">
          <button class="prestudy-mode-btn ${currentPrestudyMode === "characters" ? "active" : ""}" data-mode="characters">Characters</button>
          <button class="prestudy-mode-btn ${currentPrestudyMode === "words" ? "active" : ""}" data-mode="words">Words</button>
        </div>

        <div class="prestudy-controls">
          <div class="prestudy-shelf-select">
            <label>Select Shelf:</label>
            ${renderTwoLevelShelfSelector(shelves, "prestudy", currentPrestudyPrimaryShelfId, currentPrestudyShelfId)}
          </div>
          <div class="prestudy-target-rate">
            <label for="prestudy-target">Target Rate:</label>
            <input type="number" id="prestudy-target" min="50" max="100" step="1" value="${prestudyTargetRate}">
            <span>%</span>
          </div>
          <button id="prestudy-calculate-btn" class="btn-primary" ${!currentPrestudyShelfId ? "disabled" : ""}>
            Calculate Pre-Study ${currentPrestudyMode === "characters" ? "Characters" : "Words"}
          </button>
          ${currentPrestudyMode === "characters" ? `
          <button id="prestudy-export-btn" class="btn-secondary" ${!currentPrestudyResult ? "disabled" : ""}>
            Export to Anki
          </button>` : ""}
        </div>

        <div id="prestudy-results" class="prestudy-results">
          ${currentPrestudyMode === "characters"
            ? (currentPrestudyResult
                ? renderPrestudyResults(currentPrestudyResult)
                : '<p class="empty-message">Select a shelf and click Calculate to see pre-study characters.</p>')
            : (currentPrestudyWordResult
                ? renderPrestudyWordResults(currentPrestudyWordResult)
                : '<p class="empty-message">Select a shelf and click Calculate to see pre-study words.</p>')
          }
        </div>
      </div>
    `;

    container.innerHTML = html;
    setupPrestudyViewHandlers();

  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load pre-study view: ${error}</p>`;
  }
}

// =============================================================================
// Character prestudy rendering
// =============================================================================

function renderPrestudyResults(result: library.PreStudyResult): string {
  if (!result.needs_prestudy) {
    return `
      <div class="prestudy-success">
        <div class="success-icon">✓</div>
        <h3>No Pre-Study Needed!</h3>
        <p>Your known character rate is already at <strong>${result.current_known_rate.toFixed(1)}%</strong>,
           which meets or exceeds the ${result.target_rate}% target.</p>
        <p>You're ready to read this shelf!</p>
      </div>
    `;
  }

  const learningCount = result.characters_to_study.filter(c => c.is_learning).length;
  const unknownCount = result.characters_to_study.filter(c => !c.is_learning).length;

  const filteredCharacters = hideLearningCharacters
    ? result.characters_to_study.filter(c => !c.is_learning)
    : result.characters_to_study;

  let nonLearningIndex = 0;
  const charactersToShow = filteredCharacters.slice(0, Math.max(result.characters_needed, 50));

  return `
    <div class="prestudy-content">
      <div class="prestudy-summary">
        <div class="stat-card">
          <span class="stat-value">${result.current_known_rate.toFixed(1)}%</span>
          <span class="stat-label">Current Rate</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${result.target_rate}%</span>
          <span class="stat-label">Target Rate</span>
        </div>
        <div class="stat-card highlight-important">
          <span class="stat-value">${result.characters_needed}</span>
          <span class="stat-label">Chars to Learn</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${unknownCount}</span>
          <span class="stat-label">Unknown</span>
        </div>
        ${learningCount > 0 ? `
          <div class="stat-card">
            <span class="stat-value">${learningCount}</span>
            <span class="stat-label">Learning</span>
          </div>
        ` : ""}
      </div>

      <div class="prestudy-layout">
        <div class="prestudy-list-section">
          <div class="prestudy-list-header">
            <h3>Characters to Study (by frequency)</h3>
            ${learningCount > 0 ? `
              <label class="prestudy-filter-toggle">
                <input type="checkbox" id="hide-learning-toggle" ${hideLearningCharacters ? "checked" : ""}>
                <span>Hide learning (${learningCount})</span>
              </label>
            ` : ""}
          </div>
          <p class="prestudy-hint">Click a character to see its definition and context from the texts.</p>
          <div class="prestudy-char-list">
            ${charactersToShow.map((char) => {
              const isPriority = !char.is_learning && (nonLearningIndex < result.characters_needed);
              if (!char.is_learning) nonLearningIndex++;
              return `
                <div class="prestudy-char-item ${isPriority ? "priority" : ""} ${char.is_learning ? "learning" : ""} ${char.character === selectedPrestudyCharacter ? "selected" : ""}"
                     data-char="${escapeHtml(char.character)}">
                  <span class="prestudy-char">${char.character}</span>
                  <span class="prestudy-freq">${char.frequency}x</span>
                  <span class="prestudy-coverage">${char.cumulative_coverage.toFixed(1)}%</span>
                  ${isPriority ? '<span class="priority-marker">★</span>' : ""}
                  ${char.is_learning ? '<span class="learning-marker">📖</span>' : ""}
                </div>
              `;
            }).join("")}
          </div>
          ${filteredCharacters.length > charactersToShow.length ? `
            <p class="prestudy-more">+ ${filteredCharacters.length - charactersToShow.length} more characters</p>
          ` : ""}
        </div>

        <div class="prestudy-detail-section" id="prestudy-detail">
          <div class="prestudy-detail-placeholder">
            <p>Select a character to see its definition and context</p>
          </div>
        </div>
      </div>
    </div>
  `;
}

// =============================================================================
// Word prestudy rendering
// =============================================================================

function renderPrestudyWordResults(result: library.PreStudyWordResult): string {
  if (!result.needs_prestudy) {
    return `
      <div class="prestudy-success">
        <div class="success-icon">✓</div>
        <h3>No Pre-Study Needed!</h3>
        <p>Your known word rate is already at <strong>${result.current_known_rate.toFixed(1)}%</strong>,
           which meets or exceeds the ${result.target_rate}% target.</p>
        <p>You're ready to read this shelf!</p>
      </div>
    `;
  }

  const learningCount = result.words_to_study.filter(w => w.is_learning).length;
  const unknownCount = result.words_to_study.filter(w => !w.is_learning).length;

  const filteredWords = hideLearningWords
    ? result.words_to_study.filter(w => !w.is_learning)
    : result.words_to_study;

  let nonLearningIndex = 0;
  const wordsToShow = filteredWords.slice(0, Math.max(result.words_needed, 50));

  return `
    <div class="prestudy-content">
      <div class="prestudy-summary">
        <div class="stat-card">
          <span class="stat-value">${result.current_known_rate.toFixed(1)}%</span>
          <span class="stat-label">Current Rate</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${result.target_rate}%</span>
          <span class="stat-label">Target Rate</span>
        </div>
        <div class="stat-card highlight-important">
          <span class="stat-value">${result.words_needed}</span>
          <span class="stat-label">Words to Learn</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${unknownCount}</span>
          <span class="stat-label">Unknown</span>
        </div>
        ${learningCount > 0 ? `
          <div class="stat-card">
            <span class="stat-value">${learningCount}</span>
            <span class="stat-label">Learning</span>
          </div>
        ` : ""}
      </div>

      <div class="prestudy-layout">
        <div class="prestudy-list-section">
          <div class="prestudy-list-header">
            <h3>Words to Study (by frequency)</h3>
            ${learningCount > 0 ? `
              <label class="prestudy-filter-toggle">
                <input type="checkbox" id="hide-learning-words-toggle" ${hideLearningWords ? "checked" : ""}>
                <span>Hide learning (${learningCount})</span>
              </label>
            ` : ""}
          </div>
          <p class="prestudy-hint">Click a word to see its definition and context from the texts.</p>
          <div class="prestudy-char-list">
            ${wordsToShow.map((w) => {
              const isPriority = !w.is_learning && (nonLearningIndex < result.words_needed);
              if (!w.is_learning) nonLearningIndex++;
              return `
                <div class="prestudy-word-item ${isPriority ? "priority" : ""} ${w.is_learning ? "learning" : ""} ${w.word === selectedPrestudyWord ? "selected" : ""}"
                     data-word="${escapeHtml(w.word)}">
                  <span class="prestudy-char prestudy-word-label">${w.word}</span>
                  <span class="prestudy-freq">${w.frequency}x</span>
                  <span class="prestudy-coverage">${w.cumulative_coverage.toFixed(1)}%</span>
                  ${isPriority ? '<span class="priority-marker">★</span>' : ""}
                  ${w.is_learning ? '<span class="learning-marker">📖</span>' : ""}
                </div>
              `;
            }).join("")}
          </div>
          ${filteredWords.length > wordsToShow.length ? `
            <p class="prestudy-more">+ ${filteredWords.length - wordsToShow.length} more words</p>
          ` : ""}
        </div>

        <div class="prestudy-detail-section" id="prestudy-detail">
          <div class="prestudy-detail-placeholder">
            <p>Select a word to see its definition and context</p>
          </div>
        </div>
      </div>
    </div>
  `;
}

// =============================================================================
// Character detail panel
// =============================================================================

async function loadCharacterDetail(character: string) {
  const detailContainer = document.getElementById("prestudy-detail");
  if (!detailContainer || !currentPrestudyShelfId) return;

  detailContainer.innerHTML = '<p class="loading">Loading...</p>';

  try {
    const [lookupResult, contextResult] = await Promise.all([
      dictionary.lookup(character, {
        includeExamples: false,
        includeCharacterInfo: true,
        includeUserDictionaries: true,
      }),
      library.getCharacterContext(currentPrestudyShelfId, character, 3),
    ]);

    let html = `
      <div class="prestudy-char-detail">
        <div class="detail-header">
          <span class="detail-char">${character}</span>
          <div class="detail-actions">
            <button class="btn-mark-learning-prestudy" data-word="${escapeHtml(character)}" data-type="character">
              Mark as Learning
            </button>
            <button class="btn-mark-known-prestudy" data-word="${escapeHtml(character)}" data-type="character">
              Mark as Known
            </button>
          </div>
        </div>
    `;

    if (lookupResult.character_info) {
      const info = lookupResult.character_info;
      html += `
        <div class="detail-char-info">
          ${info.radical ? `<span class="char-info-item">Radical: ${info.radical}</span>` : ""}
          ${info.total_strokes ? `<span class="char-info-item">Strokes: ${info.total_strokes}</span>` : ""}
        </div>
      `;
    }

    if (contextResult.snippets.length > 0) {
      html += '<div class="detail-context"><h4>Context from Texts</h4>';
      for (const snippet of contextResult.snippets) {
        const chars = [...snippet.snippet];
        const before = chars.slice(0, snippet.character_position).join("");
        const target = chars.slice(snippet.character_position, snippet.character_position + 1).join("");
        const after = chars.slice(snippet.character_position + 1).join("");
        html += `
          <div class="context-snippet">
            <span class="context-text">${escapeHtml(before)}<mark>${escapeHtml(target)}</mark>${escapeHtml(after)}</span>
            <span class="context-source">— ${escapeHtml(snippet.text_title)}</span>
          </div>
        `;
      }
      html += '</div>';
    } else {
      html += '<p class="empty-message">No context snippets found.</p>';
    }

    if (lookupResult.entries.length > 0) {
      html += '<div class="detail-definitions"><h4>Definitions</h4>';
      for (const entry of lookupResult.entries.slice(0, 3)) {
        const defTexts = entry.definitions.slice(0, 3).map(d => d.text).join("; ");
        html += `
          <div class="detail-entry">
            ${entry.pinyin_display || entry.pinyin ? `<span class="detail-pinyin">${entry.pinyin_display || entry.pinyin}</span>` : ""}
            <span class="detail-def">${escapeHtml(defTexts)}</span>
          </div>
        `;
      }
      html += '</div>';
    }

    html += '</div>';
    detailContainer.innerHTML = html;

    setupDetailMarkButtons(detailContainer, "characters");
  } catch (error) {
    detailContainer.innerHTML = `<p class="error">Failed to load character detail: ${error}</p>`;
  }
}

// =============================================================================
// Word detail panel
// =============================================================================

async function loadWordDetail(word: string) {
  const detailContainer = document.getElementById("prestudy-detail");
  if (!detailContainer || !currentPrestudyShelfId) return;

  detailContainer.innerHTML = '<p class="loading">Loading...</p>';

  try {
    const [lookupResult, contextResult] = await Promise.all([
      dictionary.lookup(word, {
        includeExamples: true,
        includeCharacterInfo: false,
        includeUserDictionaries: true,
      }),
      library.getWordContext(currentPrestudyShelfId, word, 3),
    ]);

    const wordLen = [...word].length;

    let html = `
      <div class="prestudy-char-detail">
        <div class="detail-header">
          <span class="detail-char detail-word">${word}</span>
          <div class="detail-actions">
            <button class="btn-mark-learning-prestudy" data-word="${escapeHtml(word)}" data-type="word">
              Mark as Learning
            </button>
            <button class="btn-mark-known-prestudy" data-word="${escapeHtml(word)}" data-type="word">
              Mark as Known
            </button>
          </div>
        </div>
    `;

    if (lookupResult.entries.length > 0) {
      html += '<div class="detail-definitions"><h4>Definitions</h4>';
      for (const entry of lookupResult.entries.slice(0, 3)) {
        const defTexts = entry.definitions.slice(0, 4).map(d => d.text).join("; ");
        html += `
          <div class="detail-entry">
            ${entry.pinyin_display || entry.pinyin ? `<span class="detail-pinyin">${entry.pinyin_display || entry.pinyin}</span>` : ""}
            <span class="detail-def">${escapeHtml(defTexts)}</span>
          </div>
        `;
      }
      // Show usage examples from dictionary if available
      const examples = lookupResult.entries.flatMap(e => e.examples).slice(0, 2);
      if (examples.length > 0) {
        html += '<div class="detail-examples"><h4>Dictionary Examples</h4>';
        for (const ex of examples) {
          html += `
            <div class="context-snippet">
              <span class="context-text">${escapeHtml(ex.text)}</span>
              ${ex.translation ? `<span class="context-source">${escapeHtml(ex.translation)}</span>` : ""}
            </div>
          `;
        }
        html += '</div>';
      }
      html += '</div>';
    } else {
      html += '<p class="empty-message">No dictionary entry found for this word.</p>';
    }

    if (contextResult.snippets.length > 0) {
      html += '<div class="detail-context"><h4>Context from Texts</h4>';
      for (const snippet of contextResult.snippets) {
        const chars = [...snippet.snippet];
        const before = chars.slice(0, snippet.character_position).join("");
        const target = chars.slice(snippet.character_position, snippet.character_position + wordLen).join("");
        const after = chars.slice(snippet.character_position + wordLen).join("");
        html += `
          <div class="context-snippet">
            <span class="context-text">${escapeHtml(before)}<mark>${escapeHtml(target)}</mark>${escapeHtml(after)}</span>
            <span class="context-source">— ${escapeHtml(snippet.text_title)}</span>
          </div>
        `;
      }
      html += '</div>';
    } else {
      html += '<p class="empty-message">No context snippets found in this shelf.</p>';
    }

    html += '</div>';
    detailContainer.innerHTML = html;

    setupDetailMarkButtons(detailContainer, "words");
  } catch (error) {
    detailContainer.innerHTML = `<p class="error">Failed to load word detail: ${error}</p>`;
  }
}

// =============================================================================
// Shared: mark buttons in detail panel
// =============================================================================

function setupDetailMarkButtons(detailContainer: Element, mode: "characters" | "words") {
  async function markAndAdvance(btn: HTMLButtonElement, status: "known" | "learning") {
    const term = btn.dataset.word!;
    const type = btn.dataset.type!;

    let nextTerm: string | null = null;

    if (mode === "characters" && currentPrestudyResult) {
      const list = hideLearningCharacters
        ? currentPrestudyResult.characters_to_study.filter(c => !c.is_learning)
        : currentPrestudyResult.characters_to_study;
      const idx = list.findIndex(c => c.character === term);
      if (idx >= 0 && idx < list.length - 1) nextTerm = list[idx + 1].character;
    } else if (mode === "words" && currentPrestudyWordResult) {
      const list = hideLearningWords
        ? currentPrestudyWordResult.words_to_study.filter(w => !w.is_learning)
        : currentPrestudyWordResult.words_to_study;
      const idx = list.findIndex(w => w.word === term);
      if (idx >= 0 && idx < list.length - 1) nextTerm = list[idx + 1].word;
    }

    try {
      await library.addKnownWord(term, type, status);

      // Disable both buttons in detail panel
      detailContainer.querySelectorAll(".btn-mark-known-prestudy, .btn-mark-learning-prestudy")
        .forEach(b => (b as HTMLButtonElement).disabled = true);
      btn.textContent = status === "known" ? "Marked Known!" : "Marked Learning!";

      // Refresh the result and re-render the list
      if (!currentPrestudyShelfId) return;

      if (mode === "characters") {
        currentPrestudyResult = await library.getPrestudy(currentPrestudyShelfId, prestudyTargetRate);
        const resultsContainer = document.getElementById("prestudy-results");
        if (resultsContainer && currentPrestudyResult) {
          resultsContainer.innerHTML = renderPrestudyResults(currentPrestudyResult);
          setupPrestudyCharacterHandlers();
          advanceSelection("characters", nextTerm);
        }
      } else {
        currentPrestudyWordResult = await library.getPrestudyWords(currentPrestudyShelfId, prestudyTargetRate);
        const resultsContainer = document.getElementById("prestudy-results");
        if (resultsContainer && currentPrestudyWordResult) {
          resultsContainer.innerHTML = renderPrestudyWordResults(currentPrestudyWordResult);
          setupPrestudyWordHandlers();
          advanceSelection("words", nextTerm);
        }
      }
    } catch (error) {
      console.error(`Failed to mark as ${status}:`, error);
    }
  }

  detailContainer.querySelector(".btn-mark-known-prestudy")?.addEventListener("click", async (e) => {
    await markAndAdvance(e.target as HTMLButtonElement, "known");
  });
  detailContainer.querySelector(".btn-mark-learning-prestudy")?.addEventListener("click", async (e) => {
    await markAndAdvance(e.target as HTMLButtonElement, "learning");
  });
}

function advanceSelection(mode: "characters" | "words", nextTerm: string | null) {
  if (!nextTerm) {
    if (mode === "characters") selectedPrestudyCharacter = null;
    else selectedPrestudyWord = null;
    return;
  }

  const selector = mode === "characters" ? ".prestudy-char-item" : ".prestudy-word-item";

  const items = document.querySelectorAll(selector);
  const match = Array.from(items).find(el => (el as HTMLElement).dataset[mode === "characters" ? "char" : "word"] === nextTerm);

  if (match) {
    if (mode === "characters") selectedPrestudyCharacter = nextTerm;
    else selectedPrestudyWord = nextTerm;
    match.classList.add("selected");
    if (mode === "characters") loadCharacterDetail(nextTerm);
    else loadWordDetail(nextTerm);
  } else {
    if (mode === "characters") selectedPrestudyCharacter = null;
    else selectedPrestudyWord = null;
  }
}

// =============================================================================
// View setup and handlers
// =============================================================================

function setupPrestudyViewHandlers() {
  // Mode tabs
  document.querySelectorAll(".prestudy-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentPrestudyMode = (btn as HTMLElement).dataset.mode as "characters" | "words";
      loadPrestudyView();
    });
  });

  // Shelf selectors
  const onShelfChange = () => {
    currentPrestudyResult = null;
    currentPrestudyWordResult = null;
    selectedPrestudyCharacter = null;
    selectedPrestudyWord = null;

    const calcBtn = document.getElementById("prestudy-calculate-btn") as HTMLButtonElement;
    if (calcBtn) calcBtn.disabled = !currentPrestudyShelfId;

    const resultsContainer = document.getElementById("prestudy-results");
    if (resultsContainer) {
      resultsContainer.innerHTML = `<p class="empty-message">Select a shelf and click Calculate to see pre-study ${currentPrestudyMode}.</p>`;
    }
  };

  document.getElementById("prestudy-shelf-primary")?.addEventListener("change", async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    currentPrestudyPrimaryShelfId = value ? parseInt(value) : null;
    currentPrestudyShelfId = currentPrestudyPrimaryShelfId;
    onShelfChange();
    await loadPrestudyView();
  });

  document.getElementById("prestudy-shelf-secondary")?.addEventListener("change", (e) => {
    const value = (e.target as HTMLSelectElement).value;
    currentPrestudyShelfId = value ? parseInt(value) : currentPrestudyPrimaryShelfId;
    onShelfChange();
  });

  // Calculate button
  document.getElementById("prestudy-calculate-btn")?.addEventListener("click", async () => {
    if (!currentPrestudyShelfId) return;

    const btn = document.getElementById("prestudy-calculate-btn") as HTMLButtonElement;
    const resultsContainer = document.getElementById("prestudy-results");
    const targetInput = document.getElementById("prestudy-target") as HTMLInputElement;

    if (targetInput) {
      prestudyTargetRate = Math.min(100, Math.max(50, parseInt(targetInput.value) || 90));
    }

    if (btn) btn.disabled = true;
    const label = currentPrestudyMode === "characters" ? "characters" : "words";
    if (resultsContainer) resultsContainer.innerHTML = `<p class="loading">Calculating pre-study ${label}...</p>`;

    try {
      if (currentPrestudyMode === "characters") {
        currentPrestudyResult = await library.getPrestudy(currentPrestudyShelfId, prestudyTargetRate);
        selectedPrestudyCharacter = null;
        if (resultsContainer) {
          resultsContainer.innerHTML = renderPrestudyResults(currentPrestudyResult);
          setupPrestudyCharacterHandlers();
        }
        const exportBtn = document.getElementById("prestudy-export-btn") as HTMLButtonElement | null;
        if (exportBtn) {
          exportBtn.disabled = !currentPrestudyResult || currentPrestudyResult.characters_to_study.length === 0;
        }
      } else {
        currentPrestudyWordResult = await library.getPrestudyWords(currentPrestudyShelfId, prestudyTargetRate);
        selectedPrestudyWord = null;
        if (resultsContainer) {
          resultsContainer.innerHTML = renderPrestudyWordResults(currentPrestudyWordResult);
          setupPrestudyWordHandlers();
        }
      }
    } catch (error) {
      if (resultsContainer) {
        resultsContainer.innerHTML = `<p class="error">Failed to calculate: ${error}</p>`;
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Export button (characters only)
  document.getElementById("prestudy-export-btn")?.addEventListener("click", () => exportCharacters());

  setupPrestudyCharacterHandlers();
  setupPrestudyWordHandlers();
}

function setupPrestudyCharacterHandlers() {
  document.querySelectorAll(".prestudy-char-item").forEach((item) => {
    item.addEventListener("click", async () => {
      const char = (item as HTMLElement).dataset.char!;
      selectedPrestudyCharacter = char;
      document.querySelectorAll(".prestudy-char-item").forEach(el => el.classList.remove("selected"));
      item.classList.add("selected");
      await loadCharacterDetail(char);
    });
  });

  document.getElementById("hide-learning-toggle")?.addEventListener("change", (e) => {
    hideLearningCharacters = (e.target as HTMLInputElement).checked;
    const resultsContainer = document.getElementById("prestudy-results");
    if (resultsContainer && currentPrestudyResult) {
      resultsContainer.innerHTML = renderPrestudyResults(currentPrestudyResult);
      setupPrestudyCharacterHandlers();
    }
  });
}

function setupPrestudyWordHandlers() {
  document.querySelectorAll(".prestudy-word-item").forEach((item) => {
    item.addEventListener("click", async () => {
      const word = (item as HTMLElement).dataset.word!;
      selectedPrestudyWord = word;
      document.querySelectorAll(".prestudy-word-item").forEach(el => el.classList.remove("selected"));
      item.classList.add("selected");
      await loadWordDetail(word);
    });
  });

  document.getElementById("hide-learning-words-toggle")?.addEventListener("change", (e) => {
    hideLearningWords = (e.target as HTMLInputElement).checked;
    const resultsContainer = document.getElementById("prestudy-results");
    if (resultsContainer && currentPrestudyWordResult) {
      resultsContainer.innerHTML = renderPrestudyWordResults(currentPrestudyWordResult);
      setupPrestudyWordHandlers();
    }
  });
}

// =============================================================================
// Anki export (characters only)
// =============================================================================

async function exportCharacters() {
  if (!currentPrestudyResult || !currentPrestudyShelfId) return;

  const btn = document.getElementById("prestudy-export-btn") as HTMLButtonElement;
  const originalText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Exporting..."; }

  try {
    const neededCharacters = currentPrestudyResult.characters_to_study.slice(0, currentPrestudyResult.characters_needed);
    const charactersToExport = hideLearningCharacters
      ? neededCharacters.filter(c => !c.is_learning)
      : neededCharacters;

    if (charactersToExport.length === 0) { alert("No characters to export."); return; }

    const rows: string[] = [];
    for (let i = 0; i < charactersToExport.length; i++) {
      const char = charactersToExport[i].character;
      if (btn) btn.textContent = `Exporting ${i + 1}/${charactersToExport.length}...`;

      try {
        const [lookupResult, contextResult] = await Promise.all([
          dictionary.lookup(char, { includeExamples: false, includeCharacterInfo: true, includeUserDictionaries: true }),
          library.getCharacterContext(currentPrestudyShelfId!, char, 3),
        ]);

        let back = "";
        for (const entry of lookupResult.entries.slice(0, 3)) {
          const pinyin = entry.pinyin || "";
          const defTexts = entry.definitions.slice(0, 5).map(d => d.text).join("; ");
          back += pinyin ? `[${pinyin}] ${defTexts}<br>` : `${defTexts}<br>`;
        }
        if (contextResult.snippets.length > 0) {
          back += "<br><b>Context:</b><br>";
          for (const snippet of contextResult.snippets) {
            const chars = [...snippet.snippet];
            const before = chars.slice(0, snippet.character_position).join("");
            const target = chars.slice(snippet.character_position, snippet.character_position + 1).join("");
            const after = chars.slice(snippet.character_position + 1).join("");
            back += `${before}<b>${target}</b>${after} <i>(${snippet.text_title})</i><br>`;
          }
        }
        rows.push(`${char}\t${back.replace(/\t/g, " ").replace(/\n/g, " ")}`);
      } catch {
        rows.push(`${char}\t(Failed to load definitions)`);
      }
    }

    const blob = new Blob([rows.join("\n")], { type: "text/tab-separated-values;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `prestudy-characters-${new Date().toISOString().split("T")[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(`Export failed: ${error}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalText ?? "Export to Anki"; }
  }
}

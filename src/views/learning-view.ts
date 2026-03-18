import * as dictionary from "../lib/dictionary";
import * as library from "../lib/library";
import * as learning from "../lib/learning";
import { escapeHtml, createModal, closeModal } from "../utils";

// =============================================================================
// Learning View
// =============================================================================

let currentLearningSource: string | null = null;
let currentLearningTab: "characters" | "words" = "characters";
let coverageViewMode: "cumulative" | "bucket" = "cumulative";

export async function loadLearningView() {
  const container = document.getElementById("learning-main");
  if (!container) return;

  container.innerHTML = '<p class="loading">Loading learning data...</p>';

  try {
    await learning.recordVocabularySnapshot();

    const [sources, stats, progress] = await Promise.all([
      learning.listFrequencySources(),
      learning.getLearningStats(currentLearningSource ?? undefined),
      learning.getVocabularyProgress(30),
    ]);

    if (!currentLearningSource && sources.length > 0) {
      const charSource = sources.find((s) => s.name.includes("character"));
      currentLearningSource = charSource ? charSource.name.split("_")[0] : sources[0].name.split("_")[0];
    }

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

    if (sources.length > 0 && (stats.character_coverage.length > 0 || stats.word_coverage.length > 0)) {
      html += `
        <div class="percentile-section">
          <h3>Frequency Coverage</h3>
          <p class="section-description">How much of the most common vocabulary do you know?</p>

          <div class="coverage-controls">
            <div class="coverage-tabs">
              <button class="coverage-tab ${currentLearningTab === "characters" ? "active" : ""}" data-tab="characters">
                Characters
              </button>
              <button class="coverage-tab ${currentLearningTab === "words" ? "active" : ""}" data-tab="words">
                Words
              </button>
            </div>
            <div class="coverage-view-toggle">
              <button class="view-toggle-btn ${coverageViewMode === "cumulative" ? "active" : ""}" data-view="cumulative">
                Cumulative
              </button>
              <button class="view-toggle-btn ${coverageViewMode === "bucket" ? "active" : ""}" data-view="bucket">
                By Range
              </button>
            </div>
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

    html += `
      <div class="progress-section">
        <h3>Vocabulary Growth</h3>
        ${renderVocabularyProgress(progress)}
      </div>
    `;

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

    try {
      const learningItems = await library.listKnownWords(undefined, "learning");
      if (learningItems.length > 0) {
        html += `
          <div class="learning-vocabulary-section">
            <h3>Learning Vocabulary</h3>
            <p class="section-description">Words and characters you're currently studying</p>
            <div class="learning-vocab-layout">
              <div class="learning-vocab-list">
                ${learningItems.map((item) => `
                  <div class="learning-vocab-item" data-word="${escapeHtml(item.word)}" data-type="${item.word_type}">
                    <span class="vocab-term">${escapeHtml(item.word)}</span>
                    <span class="vocab-type">${item.word_type}</span>
                  </div>
                `).join("")}
              </div>
              <div class="learning-vocab-detail" id="learning-vocab-detail">
                <p class="empty-message">Click on a word to see its definition and context</p>
              </div>
            </div>
          </div>
        `;
      }
    } catch {
      // Ignore errors in learning vocabulary
    }

    html += `</div>`;

    container.innerHTML = html;

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

  if (coverageViewMode === "cumulative") {
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
  } else {
    for (let i = 0; i < coverage.length; i++) {
      const item = coverage[i];
      const prev = i > 0 ? coverage[i - 1] : null;

      const bucketTotal = prev ? item.total_terms - prev.total_terms : item.total_terms;
      const bucketKnown = prev ? item.known_terms - prev.known_terms : item.known_terms;
      const bucketLearning = prev ? item.learning_terms - prev.learning_terms : item.learning_terms;
      const bucketPercent = bucketTotal > 0 ? (bucketKnown / bucketTotal) * 100 : 0;

      const prevPercentile = prev ? prev.percentile : 0;
      const rangeLabel = `${prevPercentile}-${item.percentile}%`;

      const coverageClass = learning.getCoverageColorClass(bucketPercent);

      html += `
        <div class="coverage-row">
          <div class="coverage-label">
            <span class="percentile-label">${rangeLabel}</span>
            <span class="terms-count">${bucketTotal.toLocaleString()} terms</span>
          </div>
          <div class="coverage-bar-container">
            <div class="coverage-bar ${coverageClass}" style="width: ${bucketPercent}%">
              <span class="coverage-known">${bucketKnown.toLocaleString()} known</span>
            </div>
            ${bucketLearning > 0 ? `
              <div class="coverage-bar learning" style="width: ${(bucketLearning / bucketTotal) * 100}%">
              </div>
            ` : ""}
          </div>
          <div class="coverage-percent ${coverageClass}">
            ${learning.formatCoveragePercent(bucketPercent)}
          </div>
        </div>
      `;
    }
  }

  html += '</div>';
  return html;
}

function renderVocabularyProgress(progress: learning.VocabularyProgress[]): string {
  if (progress.length === 0) {
    return '<p class="empty-message">No progress data yet. Keep learning!</p>';
  }

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
  document.getElementById("learning-source-select")?.addEventListener("change", async (e) => {
    currentLearningSource = (e.target as HTMLSelectElement).value;
    await loadLearningView();
  });

  document.querySelectorAll(".coverage-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      currentLearningTab = (tab as HTMLElement).dataset.tab as "characters" | "words";

      document.querySelectorAll(".coverage-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      const contentDiv = document.querySelector(".coverage-content");
      if (contentDiv) {
        const coverage = currentLearningTab === "characters"
          ? stats.character_coverage
          : stats.word_coverage;
        contentDiv.innerHTML = renderPercentileCoverage(coverage);
      }
    });
  });

  document.querySelectorAll(".view-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      coverageViewMode = (btn as HTMLElement).dataset.view as "cumulative" | "bucket";

      document.querySelectorAll(".view-toggle-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const contentDiv = document.querySelector(".coverage-content");
      if (contentDiv) {
        const coverage = currentLearningTab === "characters"
          ? stats.character_coverage
          : stats.word_coverage;
        contentDiv.innerHTML = renderPercentileCoverage(coverage);
      }
    });
  });

  document.getElementById("import-frequency-btn")?.addEventListener("click", showImportFrequencyModal);

  document.querySelectorAll(".btn-mark-known-priority").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const word = (btn as HTMLElement).dataset.word!;
      const wordType = (btn as HTMLElement).dataset.type!;
      const item = (btn as HTMLElement).closest(".priority-item");

      (btn as HTMLButtonElement).textContent = "Marked!";
      (btn as HTMLButtonElement).disabled = true;

      try {
        await library.addKnownWord(word, wordType, "known");
        item?.remove();
      } catch (error) {
        console.error("Failed to mark as known:", error);
        (btn as HTMLButtonElement).textContent = "Mark Known";
        (btn as HTMLButtonElement).disabled = false;
      }
    });
  });

  document.querySelectorAll(".priority-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".btn-mark-known-priority")) return;

      const term = (item as HTMLElement).dataset.term!;
      const searchInput = document.getElementById("search-input") as HTMLInputElement;
      if (searchInput) {
        searchInput.value = term;
        document.querySelector('[data-view="dictionary"]')?.dispatchEvent(new Event("click"));
        document.getElementById("search-btn")?.click();
      }
    });
  });

  document.querySelectorAll(".learning-vocab-item").forEach((item) => {
    item.addEventListener("click", async () => {
      const word = (item as HTMLElement).dataset.word!;
      const wordType = (item as HTMLElement).dataset.type!;

      document.querySelectorAll(".learning-vocab-item").forEach((i) => i.classList.remove("selected"));
      item.classList.add("selected");

      const detailDiv = document.getElementById("learning-vocab-detail");
      if (!detailDiv) return;
      detailDiv.innerHTML = '<p class="loading">Loading...</p>';

      await loadLearningVocabDetail(word, wordType, detailDiv);
    });
  });
}

async function loadLearningVocabDetail(word: string, wordType: string, detailDiv: HTMLElement) {
  try {
    const [lookupResult, contextResult] = await Promise.all([
      dictionary.lookup(word, {
        includeExamples: false,
        includeCharacterInfo: wordType === "character",
        includeUserDictionaries: true,
      }),
      library.getWordContextAll(word, 5),
    ]);

    let html = `
      <div class="learning-vocab-detail-content">
        <div class="detail-header">
          <span class="detail-char">${escapeHtml(word)}</span>
          <div class="detail-actions">
            <button class="btn-mark-known-learning" data-word="${escapeHtml(word)}" data-type="${wordType}">
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

    if (lookupResult.entries.length > 0) {
      html += '<div class="detail-definitions"><h4>Definitions</h4>';
      for (const entry of lookupResult.entries) {
        const defTexts = entry.definitions.map(d => d.text).join("; ");
        html += `
          <div class="detail-entry">
            ${entry.pinyin ? `<span class="detail-pinyin">${entry.pinyin}</span>` : ""}
            <span class="detail-def">${escapeHtml(defTexts)}</span>
            <span class="detail-source">${dictionary.getSourceDisplayName(entry.source)}</span>
          </div>
        `;
      }
      html += '</div>';
    }

    if (lookupResult.user_entries.length > 0) {
      html += '<div class="detail-definitions"><h4>User Definitions</h4>';
      for (const entry of lookupResult.user_entries) {
        html += `
          <div class="detail-entry user-entry">
            ${entry.pinyin ? `<span class="detail-pinyin">${entry.pinyin}</span>` : ""}
            <span class="detail-def">${escapeHtml(entry.definition)}</span>
            ${entry.notes ? `<p class="detail-notes">${escapeHtml(entry.notes)}</p>` : ""}
          </div>
        `;
      }
      html += '</div>';
    }

    if (contextResult.snippets.length > 0) {
      html += '<div class="detail-context"><h4>Context from Texts</h4>';
      for (const snippet of contextResult.snippets) {
        const before = snippet.snippet.substring(0, snippet.character_position);
        const matched = snippet.snippet.substring(snippet.character_position, snippet.character_position + word.length);
        const after = snippet.snippet.substring(snippet.character_position + word.length);

        html += `
          <div class="context-snippet">
            <span class="context-text">${escapeHtml(before)}<mark>${escapeHtml(matched)}</mark>${escapeHtml(after)}</span>
            <span class="context-source">— ${escapeHtml(snippet.text_title)}</span>
          </div>
        `;
      }
      html += '</div>';
    } else {
      html += '<div class="detail-context"><h4>Context from Texts</h4><p class="empty-message">No context found in your library.</p></div>';
    }

    html += '</div>';
    detailDiv.innerHTML = html;

    detailDiv.querySelector(".btn-mark-known-learning")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const w = btn.dataset.word!;

      btn.textContent = "Marking...";
      btn.disabled = true;

      try {
        await library.updateWordStatus(w, "known");
        document.querySelector(`.learning-vocab-item[data-word="${CSS.escape(w)}"]`)?.remove();
        detailDiv.innerHTML = '<p class="success-message">Marked as known!</p>';
      } catch (error) {
        console.error("Failed to mark as known:", error);
        btn.textContent = "Mark as Known";
        btn.disabled = false;
      }
    });
  } catch (error) {
    console.error("Failed to load vocab detail:", error);
    detailDiv.innerHTML = `<p class="error">Failed to load details: ${error}</p>`;
  }
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

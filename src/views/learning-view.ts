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

type MonthlyVocabularyProgress = learning.VocabularyProgress & {
  month: string;
};

export async function loadLearningView() {
  const container = document.getElementById("learning-main");
  if (!container) return;

  container.innerHTML = '<p class="loading">Loading learning data...</p>';

  try {
    await learning.recordVocabularySnapshot();

    const [sources, stats, progress] = await Promise.all([
      learning.listFrequencySources(),
      learning.getLearningStats(currentLearningSource ?? undefined),
      learning.getVocabularyProgress(730),
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
        const [characterPriorities, wordPriorities] = await Promise.all([
          learning.getStudyPriorities(currentLearningSource, "character", 20),
          learning.getStudyPriorities(currentLearningSource, "word", 20),
        ]);

        html += `
          <div class="priorities-section">
            <h3>Study Priorities</h3>
            <p class="section-description">High-frequency unknown and learning items to review</p>
            <div class="learning-priorities-layout">
              <div class="learning-priorities-main">
                <section class="priority-group">
                  <h4>Character Learning Priorities</h4>
                  ${renderStudyPriorities(characterPriorities)}
                </section>
                <section class="priority-group">
                  <h4>Word Learning Priorities</h4>
                  ${renderStudyPriorities(wordPriorities)}
                </section>
              </div>
              <aside class="dict-sidebar" id="learning-dict-sidebar">
                <div class="dict-sidebar-header">
                  <h3>Lookup</h3>
                  <button class="dict-sidebar-close" id="learning-dict-sidebar-close">&times;</button>
                </div>
                <div class="dict-sidebar-content" id="learning-dict-sidebar-content">
                  <p class="dict-sidebar-empty">Click a priority item to review it</p>
                </div>
              </aside>
            </div>
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

  const monthlyProgress = getMonthlyVocabularyProgress(progress).slice(-24);

  let html = `
    <div class="progress-table-container">
      <table class="progress-table">
        <thead>
          <tr>
            <th>Month</th>
            <th>Known Chars</th>
            <th>Known Words</th>
            <th>Learning</th>
          </tr>
        </thead>
        <tbody>
  `;

  const displayProgress = [...monthlyProgress].reverse();

  for (let i = 0; i < displayProgress.length; i++) {
    const item = displayProgress[i];
    const prev = displayProgress[i + 1] || null;
    const diff = learning.calculateProgressDiff(item, prev);

    html += `
      <tr>
        <td>${formatProgressMonth(item.month)}</td>
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
    return '<p class="empty-message">No unknown priorities found.</p>';
  }

  let html = '<div class="priorities-list">';

  for (const item of priorities) {
    const statusClass = item.is_learning ? "learning" : "unknown";
    const statusBadge = item.is_learning ? '<span class="learning-badge">Learning</span>' : "";

    html += `
      <button type="button" class="priority-item ${statusClass}" data-term="${escapeHtml(item.term)}" data-type="${item.term_type}">
        <span class="priority-term">${escapeHtml(item.term)}</span>
        <span class="priority-type">${item.term_type}</span>
        ${item.rank ? `<span class="priority-rank">#${item.rank.toLocaleString()}</span>` : ""}
        ${statusBadge}
      </button>
    `;
  }

  html += '</div>';
  return html;
}

function getMonthlyVocabularyProgress(progress: learning.VocabularyProgress[]): MonthlyVocabularyProgress[] {
  const monthMap = new Map<string, MonthlyVocabularyProgress>();

  for (const item of progress) {
    const month = item.date.slice(0, 7);
    const existing = monthMap.get(month);
    if (!existing || item.date > existing.date) {
      monthMap.set(month, { ...item, month });
    }
  }

  return [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function formatProgressMonth(monthStr: string): string {
  const [year, month] = monthStr.split("-").map(Number);
  const date = new Date(year, month - 1, 1);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short" });
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

  document.querySelectorAll(".priority-item").forEach((item) => {
    item.addEventListener("click", async () => {
      const term = (item as HTMLElement).dataset.term!;
      const termType = (item as HTMLElement).dataset.type as "character" | "word";

      document.querySelectorAll(".priority-item").forEach((i) => i.classList.remove("selected"));
      item.classList.add("selected");
      await lookupLearningPrioritySidebar(term, termType);
    });
  });

  document.getElementById("learning-dict-sidebar-close")?.addEventListener("click", () => {
    const content = document.getElementById("learning-dict-sidebar-content");
    if (content) {
      content.innerHTML = '<p class="dict-sidebar-empty">Click a priority item to review it</p>';
    }
    document.getElementById("learning-dict-sidebar")?.classList.remove("open");
    document.querySelectorAll(".priority-item").forEach((i) => i.classList.remove("selected"));
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

async function lookupLearningPrioritySidebar(term: string, termType: "character" | "word") {
  const sidebar = document.getElementById("learning-dict-sidebar");
  const sidebarContent = document.getElementById("learning-dict-sidebar-content");
  if (!sidebar || !sidebarContent) return;

  sidebar.classList.add("open");
  sidebarContent.innerHTML = `<p class="loading">Looking up ${escapeHtml(term)}...</p>`;

  try {
    const result = await dictionary.lookup(term, {
      includeExamples: false,
      includeCharacterInfo: termType === "character",
      includeUserDictionaries: true,
    });

    await renderLearningPrioritySidebarResults(result, termType);
  } catch (error) {
    console.error("Priority lookup failed:", error);
    sidebarContent.innerHTML = `<p class="dict-sidebar-empty">"${escapeHtml(term)}" is not available offline. Reconnect to look it up.</p>`;
  }
}

async function renderLearningPrioritySidebarResults(result: dictionary.LookupResult, termType: "character" | "word") {
  const sidebarContent = document.getElementById("learning-dict-sidebar-content");
  if (!sidebarContent) return;

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
    html += `<p class="dict-sidebar-empty">No dictionary entries found for "${escapeHtml(result.query)}"</p>`;
  }

  if (result.character_info) {
    const char = result.character_info;
    html += `
      <div class="entry">
        <div class="entry-header">
          <span class="traditional" style="font-size: 2rem;">${escapeHtml(char.character)}</span>
        </div>
        <div style="font-size: 0.85rem; color: #888; margin-top: 0.5rem;">
          ${char.radical ? `Radical: ${escapeHtml(char.radical)} (#${char.radical_number})` : ""}
          ${char.total_strokes ? ` · ${char.total_strokes} strokes` : ""}
        </div>
      </div>
    `;
  }

  for (const entry of result.entries.slice(0, 5)) {
    html += `
      <div class="entry">
        <div class="entry-header">
          <span class="traditional">${escapeHtml(entry.traditional)}</span>
          ${entry.simplified !== entry.traditional ? `<span class="simplified">(${escapeHtml(entry.simplified)})</span>` : ""}
          <span class="pinyin">${escapeHtml(dictionary.formatPinyin(entry))}</span>
        </div>
        <div class="definitions">
          ${entry.definitions.slice(0, 3)
            .map(def => `
              <div class="definition">
                ${def.part_of_speech ? `<span class="pos">${escapeHtml(def.part_of_speech)}</span>` : ""}
                <span class="def-text">${escapeHtml(def.text)}</span>
              </div>
            `)
            .join("")}
        </div>
      </div>
    `;
  }

  for (const entry of result.user_entries.slice(0, 3)) {
    html += `
      <div class="entry user-entry">
        <div class="entry-header">
          <span class="traditional">${escapeHtml(entry.term)}</span>
          ${entry.pinyin ? `<span class="pinyin">${escapeHtml(entry.pinyin)}</span>` : ""}
        </div>
        <div class="definitions">
          <div class="definition">
            <span class="def-text">${escapeHtml(entry.definition)}</span>
          </div>
        </div>
      </div>
    `;
  }

  sidebarContent.innerHTML = html;
  setupLearningPrioritySidebarActions(sidebarContent);
}

function setupLearningPrioritySidebarActions(sidebarContent: HTMLElement) {
  sidebarContent.querySelectorAll(".btn-mark-known-sidebar, .btn-mark-learning-sidebar").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const button = btn as HTMLButtonElement;
      const word = button.dataset.word!;
      const wordType = button.dataset.type!;
      const status = button.classList.contains("btn-mark-known-sidebar") ? "known" : "learning";
      const defaultText = status === "known" ? "Mark Known" : "Mark Learning";

      button.textContent = status === "known" ? "Marked Known" : "Marked Learning";
      button.disabled = true;
      sidebarContent.querySelectorAll(".btn-mark-known-sidebar, .btn-mark-learning-sidebar").forEach((other) => {
        (other as HTMLButtonElement).disabled = true;
      });

      try {
        await library.addKnownWord(word, wordType, status);
        if (status === "known") {
          document.querySelectorAll(`.priority-item[data-term="${CSS.escape(word)}"]`).forEach((item) => {
            item.remove();
          });
        } else {
          document.querySelectorAll(`.priority-item[data-term="${CSS.escape(word)}"]`).forEach((item) => {
            item.classList.remove("unknown");
            item.classList.add("learning");
            if (!item.querySelector(".learning-badge")) {
              item.insertAdjacentHTML("beforeend", '<span class="learning-badge">Learning</span>');
            }
          });
          button.textContent = "Marked Learning";
        }
      } catch (error) {
        console.error(`Failed to mark as ${status}:`, error);
        button.textContent = defaultText;
        sidebarContent.querySelectorAll(".btn-mark-known-sidebar, .btn-mark-learning-sidebar").forEach((other) => {
          (other as HTMLButtonElement).disabled = false;
        });
      }
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

import * as dictionary from "../lib/dictionary";
import * as library from "../lib/library";
import { escapeHtml, renderTwoLevelShelfSelector } from "../utils";

// =============================================================================
// Pre-Study View
// =============================================================================

let currentPrestudyShelfId: number | null = null;
let currentPrestudyPrimaryShelfId: number | null = null;
let currentPrestudyResult: library.PreStudyResult | null = null;
let selectedPrestudyCharacter: string | null = null;
let hideLearningCharacters: boolean = true;
let prestudyTargetRate: number = 90;

export async function loadPrestudyView() {
  const container = document.getElementById("prestudy-main");
  if (!container) return;

  try {
    const shelves = await library.getShelfTree();

    let html = `
      <div class="prestudy-view">
        <div class="prestudy-header">
          <h2>Pre-Study Characters</h2>
          <p class="prestudy-description">
            Learn high-frequency characters before reading to improve comprehension.
            Select a shelf, set your target known rate, and calculate which characters to study.
          </p>
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
            Calculate Pre-Study Characters
          </button>
          <button id="prestudy-export-btn" class="btn-secondary" ${!currentPrestudyResult ? "disabled" : ""}>
            Export to Anki
          </button>
        </div>

        <div id="prestudy-results" class="prestudy-results">
          ${currentPrestudyResult ? renderPrestudyResults(currentPrestudyResult) : '<p class="empty-message">Select a shelf and click Calculate to see pre-study characters.</p>'}
        </div>
      </div>
    `;

    container.innerHTML = html;
    setupPrestudyViewHandlers();

  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load pre-study view: ${error}</p>`;
  }
}

function renderPrestudyResults(result: library.PreStudyResult): string {
  if (!result.needs_prestudy) {
    return `
      <div class="prestudy-success">
        <div class="success-icon">✓</div>
        <h3>No Pre-Study Needed!</h3>
        <p>Your known character rate is already at <strong>${result.current_known_rate.toFixed(1)}%</strong>,
           which meets or exceeds the 90% target.</p>
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
        const before = snippet.snippet.substring(0, snippet.character_position);
        const char = snippet.snippet.substring(snippet.character_position, snippet.character_position + 1);
        const after = snippet.snippet.substring(snippet.character_position + 1);

        html += `
          <div class="context-snippet">
            <span class="context-text">${escapeHtml(before)}<mark>${escapeHtml(char)}</mark>${escapeHtml(after)}</span>
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
            ${entry.pinyin ? `<span class="detail-pinyin">${entry.pinyin}</span>` : ""}
            <span class="detail-def">${escapeHtml(defTexts)}</span>
          </div>
        `;
      }
      html += '</div>';
    }

    html += '</div>';
    detailContainer.innerHTML = html;

    async function markCharacterAndRefresh(btn: HTMLButtonElement, status: "known" | "learning") {
      const word = btn.dataset.word!;
      const type = btn.dataset.type!;

      try {
        let nextCharacter: string | null = null;
        if (currentPrestudyResult) {
          const filteredList = hideLearningCharacters
            ? currentPrestudyResult.characters_to_study.filter(c => !c.is_learning)
            : currentPrestudyResult.characters_to_study;
          const currentIndex = filteredList.findIndex(c => c.character === word);
          if (currentIndex >= 0 && currentIndex < filteredList.length - 1) {
            nextCharacter = filteredList[currentIndex + 1].character;
          }
        }

        await library.addKnownWord(word, type, status);

        const knownBtn = detailContainer?.querySelector(".btn-mark-known-prestudy") as HTMLButtonElement | null;
        const learningBtn = detailContainer?.querySelector(".btn-mark-learning-prestudy") as HTMLButtonElement | null;

        if (status === "known") {
          btn.textContent = "Marked Known!";
        } else {
          btn.textContent = "Marked Learning!";
        }

        if (knownBtn) knownBtn.disabled = true;
        if (learningBtn) learningBtn.disabled = true;

        if (currentPrestudyShelfId) {
          currentPrestudyResult = await library.getPrestudy(currentPrestudyShelfId, prestudyTargetRate);
          const resultsContainer = document.getElementById("prestudy-results");
          if (resultsContainer && currentPrestudyResult) {
            resultsContainer.innerHTML = renderPrestudyResults(currentPrestudyResult);
            setupPrestudyCharacterHandlers();

            if (nextCharacter) {
              const newFilteredList = hideLearningCharacters
                ? currentPrestudyResult.characters_to_study.filter(c => !c.is_learning)
                : currentPrestudyResult.characters_to_study;
              const stillExists = newFilteredList.some(c => c.character === nextCharacter);

              if (stillExists) {
                selectedPrestudyCharacter = nextCharacter;
                document.querySelectorAll(".prestudy-char-item").forEach(el => {
                  if ((el as HTMLElement).dataset.char === nextCharacter) {
                    el.classList.add("selected");
                  }
                });
                await loadCharacterDetail(nextCharacter);
              } else if (newFilteredList.length > 0) {
                const firstChar = newFilteredList[0].character;
                selectedPrestudyCharacter = firstChar;
                document.querySelector(".prestudy-char-item")?.classList.add("selected");
                await loadCharacterDetail(firstChar);
              } else {
                selectedPrestudyCharacter = null;
              }
            } else {
              selectedPrestudyCharacter = null;
            }
          }
        }
      } catch (error) {
        console.error(`Failed to mark as ${status}:`, error);
      }
    }

    detailContainer.querySelector(".btn-mark-known-prestudy")?.addEventListener("click", async (e) => {
      await markCharacterAndRefresh(e.target as HTMLButtonElement, "known");
    });

    detailContainer.querySelector(".btn-mark-learning-prestudy")?.addEventListener("click", async (e) => {
      await markCharacterAndRefresh(e.target as HTMLButtonElement, "learning");
    });

  } catch (error) {
    detailContainer.innerHTML = `<p class="error">Failed to load character detail: ${error}</p>`;
  }
}

function setupPrestudyViewHandlers() {
  const onShelfChange = () => {
    currentPrestudyResult = null;
    selectedPrestudyCharacter = null;

    const btn = document.getElementById("prestudy-calculate-btn") as HTMLButtonElement;
    if (btn) {
      btn.disabled = !currentPrestudyShelfId;
    }

    const resultsContainer = document.getElementById("prestudy-results");
    if (resultsContainer) {
      resultsContainer.innerHTML = '<p class="empty-message">Select a shelf and click Calculate to see pre-study characters.</p>';
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

  document.getElementById("prestudy-calculate-btn")?.addEventListener("click", async () => {
    if (!currentPrestudyShelfId) return;

    const btn = document.getElementById("prestudy-calculate-btn") as HTMLButtonElement;
    const resultsContainer = document.getElementById("prestudy-results");
    const targetInput = document.getElementById("prestudy-target") as HTMLInputElement;

    if (targetInput) {
      prestudyTargetRate = Math.min(100, Math.max(50, parseInt(targetInput.value) || 90));
    }

    if (btn) btn.disabled = true;
    if (resultsContainer) resultsContainer.innerHTML = '<p class="loading">Calculating pre-study characters...</p>';

    try {
      currentPrestudyResult = await library.getPrestudy(currentPrestudyShelfId, prestudyTargetRate);
      selectedPrestudyCharacter = null;

      if (resultsContainer) {
        resultsContainer.innerHTML = renderPrestudyResults(currentPrestudyResult);
        setupPrestudyCharacterHandlers();
      }

      const exportBtn = document.getElementById("prestudy-export-btn") as HTMLButtonElement;
      if (exportBtn) {
        exportBtn.disabled = !currentPrestudyResult || currentPrestudyResult.characters_to_study.length === 0;
      }
    } catch (error) {
      if (resultsContainer) {
        resultsContainer.innerHTML = `<p class="error">Failed to calculate: ${error}</p>`;
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById("prestudy-export-btn")?.addEventListener("click", async () => {
    if (!currentPrestudyResult || !currentPrestudyShelfId) return;

    const btn = document.getElementById("prestudy-export-btn") as HTMLButtonElement;
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Exporting...";

    try {
      const neededCount = currentPrestudyResult.characters_needed;
      const neededCharacters = currentPrestudyResult.characters_to_study.slice(0, neededCount);

      const charactersToExport = hideLearningCharacters
        ? neededCharacters.filter(c => !c.is_learning)
        : neededCharacters;

      if (charactersToExport.length === 0) {
        alert("No characters to export.");
        return;
      }

      const rows: string[] = [];

      for (let i = 0; i < charactersToExport.length; i++) {
        const char = charactersToExport[i].character;
        btn.textContent = `Exporting ${i + 1}/${charactersToExport.length}...`;

        try {
          const [lookupResult, contextResult] = await Promise.all([
            dictionary.lookup(char, {
              includeExamples: false,
              includeCharacterInfo: true,
              includeUserDictionaries: true,
            }),
            library.getCharacterContext(currentPrestudyShelfId, char, 3),
          ]);

          let back = "";

          if (lookupResult.entries.length > 0) {
            for (const entry of lookupResult.entries.slice(0, 3)) {
              const pinyin = entry.pinyin || "";
              const defTexts = entry.definitions.slice(0, 5).map(d => d.text).join("; ");
              if (pinyin) {
                back += `[${pinyin}] ${defTexts}<br>`;
              } else {
                back += `${defTexts}<br>`;
              }
            }
          }

          if (contextResult.snippets.length > 0) {
            back += "<br><b>Context:</b><br>";
            for (const snippet of contextResult.snippets) {
              const before = snippet.snippet.substring(0, snippet.character_position);
              const charInContext = snippet.snippet.substring(snippet.character_position, snippet.character_position + 1);
              const after = snippet.snippet.substring(snippet.character_position + 1);
              back += `${before}<b>${charInContext}</b>${after} <i>(${snippet.text_title})</i><br>`;
            }
          }

          const escapedBack = back.replace(/\t/g, " ").replace(/\n/g, " ");
          rows.push(`${char}\t${escapedBack}`);
        } catch (error) {
          console.error(`Failed to fetch data for ${char}:`, error);
          rows.push(`${char}\t(Failed to load definitions)`);
        }
      }

      const tsvContent = rows.join("\n");
      const blob = new Blob([tsvContent], { type: "text/tab-separated-values;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `prestudy-characters-${new Date().toISOString().split("T")[0]}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    } catch (error) {
      console.error("Export failed:", error);
      alert(`Export failed: ${error}`);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  setupPrestudyCharacterHandlers();
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

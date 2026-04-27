import * as dictionary from "../lib/dictionary";
import * as library from "../lib/library";
import * as speed from "../lib/speed";
import { confirm } from "../lib/api";
import {
  escapeHtml,
  createModal,
  closeModal,
  findShelfById,
  renderShelfOptions,
  renderShelfOptionsExcluding,
  getShelfAndDescendantIds,
  isCjkCharacter,
} from "../utils";
import {
  selectedShelfId, setSelectedShelfId,
  shelfTree, setShelfTree,
  activeSession, setActiveSession,
  sessionTimerInterval, setSessionTimerInterval,
  currentTextId, setCurrentTextId,
  currentShelfTexts, setCurrentShelfTexts,
  currentTextSegments, setCurrentTextSegments,
} from "../state";

// =============================================================================
// Library View
// =============================================================================

// Track current sort mode (local to library view)
let currentSort: library.FrequencySort = "text_frequency";

export function setupLibraryView() {
  const addShelfBtn = document.getElementById("add-shelf-btn");
  addShelfBtn?.addEventListener("click", showAddShelfModal);

  const drawerToggle = document.getElementById("shelf-drawer-toggle");
  const drawerClose = document.getElementById("shelf-drawer-close");
  const drawerBackdrop = document.getElementById("shelf-drawer-backdrop");

  drawerToggle?.addEventListener("click", openShelfDrawer);
  drawerClose?.addEventListener("click", closeShelfDrawer);
  drawerBackdrop?.addEventListener("click", closeShelfDrawer);
}

function openShelfDrawer() {
  document.getElementById("shelf-sidebar")?.classList.add("open");
  document.getElementById("shelf-drawer-backdrop")?.classList.add("visible");
}

function closeShelfDrawer() {
  document.getElementById("shelf-sidebar")?.classList.remove("open");
  document.getElementById("shelf-drawer-backdrop")?.classList.remove("visible");
}

export async function loadShelfTree() {
  try {
    setShelfTree(await library.getShelfTree());
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

  container.querySelectorAll(".shelf-item").forEach((item) => {
    item.addEventListener("click", async (e) => {
      e.stopPropagation();
      const shelfId = parseInt((item as HTMLElement).dataset.shelfId!);
      selectShelf(shelfId);
    });
  });

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
      const textWord = node.text_count === 1 ? "text" : "texts";
      const countTitle = node.unread_count > 0
        ? `${node.text_count} ${textWord}, ${node.unread_count} unread`
        : `${node.text_count} ${textWord}`;

      return `
        <div class="shelf-node" data-depth="${depth}">
          <div class="shelf-item ${isSelected ? "selected" : ""}" data-shelf-id="${node.shelf.id}" title="${escapeHtml(node.shelf.name)}">
            ${hasChildren ? '<span class="shelf-toggle">▶</span>' : '<span class="shelf-toggle-placeholder"></span>'}
            <span class="shelf-name">${escapeHtml(node.shelf.name)}</span>
            <span class="shelf-count" title="${countTitle}">${
              node.unread_count > 0
                ? `${node.text_count}<span class="shelf-count-sep">/</span><span class="shelf-unread">${node.unread_count}</span>`
                : node.text_count
            }</span>
          </div>
          ${hasChildren ? `<div class="shelf-children">${renderShelfNodes(node.children, depth + 1)}</div>` : ""}
        </div>
      `;
    })
    .join("");
}

async function selectShelf(shelfId: number) {
  setSelectedShelfId(shelfId);

  document.querySelectorAll(".shelf-item").forEach((item) => {
    item.classList.toggle("selected", parseInt((item as HTMLElement).dataset.shelfId!) === shelfId);
  });

  closeShelfDrawer();
  await loadTextsInShelf(shelfId);
}

async function loadTextsInShelf(shelfId: number) {
  const mainContainer = document.getElementById("library-main");
  if (!mainContainer) return;

  try {
    const texts = await library.listTextsInShelf(shelfId);
    setCurrentShelfTexts(texts);
    const shelf = findShelfById(shelfTree, shelfId);

    let shelfAnalysis: library.ShelfAnalysis | null = null;
    try {
      shelfAnalysis = await library.getShelfAnalysis(shelfId);
    } catch {
      // Ignore errors - will just not show analysis
    }

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

    if (shelfAnalysis !== null && shelfAnalysis.text_count > 0) {
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
        <details class="shelf-analysis shelf-analysis-details" open>
          <summary class="shelf-analysis-summary">Shelf Analysis</summary>
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
        </details>
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

    html += `</div>`;

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

    html += `</div>`;

    mainContainer.innerHTML = html;

    document.getElementById("add-text-btn")?.addEventListener("click", () => showAddTextModal(shelfId));
    document.getElementById("split-large-texts-btn")?.addEventListener("click", () => splitLargeTextsInShelf(shelfId));
    document.getElementById("edit-shelf-btn")?.addEventListener("click", () => showEditShelfModal(shelfId));
    document.getElementById("move-shelf-btn")?.addEventListener("click", () => showMoveShelfModal(shelfId));
    document.getElementById("delete-shelf-btn")?.addEventListener("click", () => confirmDeleteShelf(shelfId));

    mainContainer.querySelectorAll(".text-item").forEach((item) => {
      item.addEventListener("click", () => {
        const textId = parseInt((item as HTMLElement).dataset.textId!);
        loadTextView(textId);
      });
    });

    mainContainer.querySelectorAll(".btn-mark-known-shelf").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const word = (btn as HTMLElement).dataset.word!;
        const wordType = (btn as HTMLElement).dataset.type!;
        const freqItem = (btn as HTMLElement).closest(".freq-item");

        (btn as HTMLButtonElement).textContent = "Marked!";
        (btn as HTMLButtonElement).disabled = true;
        freqItem?.classList.remove("unknown");
        freqItem?.classList.add("known");

        try {
          await library.addKnownWord(word, wordType);
          btn.outerHTML = '<span class="known-badge">Known</span>';
        } catch (error) {
          console.error("Failed to mark as known:", error);
          (btn as HTMLButtonElement).textContent = "Mark Known";
          (btn as HTMLButtonElement).disabled = false;
          freqItem?.classList.add("unknown");
          freqItem?.classList.remove("known");
        }
      });
    });

    mainContainer.querySelectorAll(".shelf-analysis .freq-item[data-lookup]").forEach((item) => {
      item.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".btn-mark-known-shelf")) return;

        const term = (item as HTMLElement).dataset.lookup!;
        const termType = (item as HTMLElement).dataset.lookupType as "character" | "word";

        mainContainer.querySelectorAll(".shelf-analysis .freq-item").forEach(el => el.classList.remove("selected"));
        item.classList.add("selected");

        lookupInShelfSidebar(term, termType);
      });
    });

    document.getElementById("shelf-dict-sidebar-close")?.addEventListener("click", () => {
      const content = document.getElementById("shelf-dict-sidebar-content");
      if (content) {
        content.innerHTML = '<p class="dict-sidebar-empty">Click on a word or character to look it up</p>';
      }
      document.getElementById("shelf-dict-sidebar")?.classList.remove("open");
      mainContainer.querySelectorAll(".freq-item.selected").forEach(el => el.classList.remove("selected"));
    });

    if (window.matchMedia("(max-width: 700px)").matches) {
      document.querySelector(".shelf-analysis-details")?.removeAttribute("open");
    }
  } catch (error) {
    mainContainer.innerHTML = `<p class="error">Failed to load texts: ${error}</p>`;
  }
}

async function loadTextView(textId: number) {
  const mainContainer = document.getElementById("library-main");
  if (!mainContainer) return;

  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    setSessionTimerInterval(null);
  }

  try {
    const text = await library.getText(textId);

    setActiveSession(await speed.getActiveReadingSession(textId));

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
              : `<button id="start-reading-btn" class="btn-primary">Start Reading</button>
                <button id="log-offline-btn" class="btn-secondary">Log offline read</button>`
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
          <button class="text-tab" data-tab="learning">Learning</button>
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

            <div id="text-learning-tab" class="text-tab-content">
              <div id="learning-container">
                <p class="loading">Loading learning items...</p>
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

    loadInteractiveText(text.content, textId);

    if (activeSession) {
      startSessionTimer(activeSession.started_at);
    }

    mainContainer.querySelectorAll(".text-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const tabName = (tab as HTMLElement).dataset.tab;

        mainContainer.querySelectorAll(".text-tab").forEach((t) => t.classList.remove("active"));
        mainContainer.querySelectorAll(".text-tab-content").forEach((c) => c.classList.remove("active"));

        tab.classList.add("active");
        document.getElementById(`text-${tabName}-tab`)?.classList.add("active");

        if (tabName === "analysis") {
          loadAnalysis(textId);
        } else if (tabName === "learning") {
          loadLearningItems();
        } else if (tabName === "history") {
          loadReadingHistory(textId);
        }
      });
    });

    document.getElementById("back-to-shelf-btn")?.addEventListener("click", () => {
      if (sessionTimerInterval) {
        clearInterval(sessionTimerInterval);
        setSessionTimerInterval(null);
      }
      if (selectedShelfId) loadTextsInShelf(selectedShelfId);
    });

    document.getElementById("prev-section-btn")?.addEventListener("click", (e) => {
      const btn = e.target as HTMLButtonElement;
      if (btn.disabled) return;
      const prevId = parseInt(btn.dataset.textId || "0");
      if (prevId) {
        if (sessionTimerInterval) {
          clearInterval(sessionTimerInterval);
          setSessionTimerInterval(null);
        }
        loadTextView(prevId);
      }
    });

    document.getElementById("next-section-btn")?.addEventListener("click", (e) => {
      const btn = e.target as HTMLButtonElement;
      if (btn.disabled) return;
      const nextId = parseInt(btn.dataset.textId || "0");
      if (nextId) {
        if (sessionTimerInterval) {
          clearInterval(sessionTimerInterval);
          setSessionTimerInterval(null);
        }
        loadTextView(nextId);
      }
    });

    document.getElementById("analyze-text-btn")?.addEventListener("click", async () => {
      await library.reanalyzeText(textId);
      mainContainer.querySelector('[data-tab="analysis"]')?.dispatchEvent(new Event("click"));
    });

    document.getElementById("delete-text-btn")?.addEventListener("click", () => confirmDeleteText(textId));

    setupReadingControls(textId);

    document.getElementById("dict-sidebar-close")?.addEventListener("click", () => {
      const content = document.getElementById("dict-sidebar-content");
      if (content) {
        content.innerHTML = '<p class="dict-sidebar-empty">Click on a word or character to look it up</p>';
      }
      document.getElementById("dict-sidebar")?.classList.remove("open");
      document.querySelectorAll(".text-segment.selected").forEach(el => el.classList.remove("selected"));
    });
  } catch (error) {
    mainContainer.innerHTML = `<p class="error">Failed to load text: ${error}</p>`;
  }
}

async function finishCurrentReadingSession(): Promise<void> {
  if (!activeSession) return;

  const textId = activeSession.text_id;

  try {
    const finished = await speed.finishReadingSession(activeSession.id);
    if (sessionTimerInterval) {
      clearInterval(sessionTimerInterval);
      setSessionTimerInterval(null);
    }

    let autoMarkMessage = "";
    const autoMarkEnabled = await library.isAutoMarkEnabled();
    if (autoMarkEnabled) {
      try {
        const stats = await library.autoMarkTextAsKnown(textId);
        if (stats.characters_marked > 0 || stats.words_marked > 0) {
          autoMarkMessage = `\n\nAuto-marked: ${stats.characters_marked} characters, ${stats.words_marked} words`;

          await speed.updateSessionAutoMarked(
            finished.id,
            stats.characters_marked,
            stats.words_marked
          );

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

    setActiveSession(null);
    updateReadingControlsUI();

    const cpm = finished.characters_per_minute?.toFixed(1) || "0";
    const duration = speed.formatDuration(finished.duration_seconds || 0);
    alert(`Reading complete!\n\nTime: ${duration}\nSpeed: ${cpm} chars/min${autoMarkMessage}`);
  } catch (error) {
    console.error("Failed to finish reading session:", error);
    alert(`Failed to finish reading: ${error}`);
  }
}

function setupReadingControls(textId: number) {
  document.getElementById("start-reading-btn")?.addEventListener("click", async () => {
    try {
      setActiveSession(await speed.startReadingSession(textId));
      updateReadingControlsUI();
      startSessionTimer(activeSession!.started_at);
    } catch (error) {
      console.error("Failed to start reading session:", error);
      alert(`Failed to start reading: ${error}`);
    }
  });

  document.getElementById("log-offline-btn")?.addEventListener("click", () => {
    showOfflineLogModal();
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
        setSessionTimerInterval(null);
      }
      setActiveSession(null);
      updateReadingControlsUI();
    } catch (error) {
      console.error("Failed to discard reading session:", error);
      alert(`Failed to discard: ${error}`);
    }
  });
}

function updateReadingControlsUI() {
  const container = document.getElementById("reading-controls");
  if (!container) return;

  if (activeSession) {
    container.innerHTML = `
      <span class="session-timer" id="session-timer">${speed.formatElapsedTime(activeSession.started_at)}</span>
      <button id="finish-reading-btn" class="btn-primary">Finish Reading</button>
      <button id="discard-reading-btn" class="btn-secondary">Discard</button>
    `;
    document.getElementById("finish-reading-btn")?.addEventListener("click", finishCurrentReadingSession);

    document.getElementById("discard-reading-btn")?.addEventListener("click", async () => {
      if (!activeSession) return;
      const confirmed = await confirm("Discard this reading session? This cannot be undone.");
      if (!confirmed) return;
      try {
        await speed.discardReadingSession(activeSession.id);
        if (sessionTimerInterval) {
          clearInterval(sessionTimerInterval);
          setSessionTimerInterval(null);
        }
        setActiveSession(null);
        updateReadingControlsUI();
      } catch (error) {
        console.error("Failed to discard reading session:", error);
        alert(`Failed to discard: ${error}`);
      }
    });
  } else {
    container.innerHTML = `<button id="start-reading-btn" class="btn-primary">Start Reading</button>
<button id="log-offline-btn" class="btn-secondary">Log offline read</button>`;

    document.getElementById("start-reading-btn")?.addEventListener("click", async () => {
      const backBtn = document.getElementById("back-to-shelf-btn");
      const curTextId = backBtn ? parseInt((backBtn as HTMLElement).dataset.textId || "0") : 0;
      if (!curTextId) return;

      try {
        setActiveSession(await speed.startReadingSession(curTextId));
        updateReadingControlsUI();
        startSessionTimer(activeSession!.started_at);
      } catch (error) {
        console.error("Failed to start reading session:", error);
        alert(`Failed to start reading: ${error}`);
      }
    });

    document.getElementById("log-offline-btn")?.addEventListener("click", () => {
      showOfflineLogModal();
    });
  }
}

function startSessionTimer(startedAt: string) {
  const timerEl = document.getElementById("session-timer");
  if (!timerEl) return;

  timerEl.textContent = speed.formatElapsedTime(startedAt);

  setSessionTimerInterval(window.setInterval(() => {
    const el = document.getElementById("session-timer");
    if (el) {
      el.textContent = speed.formatElapsedTime(startedAt);
    }
  }, 1000));
}

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
      const isManual = session.is_manual_log;
      const statusClass = isManual ? "manual" : session.is_complete ? "complete" : "in-progress";
      const statusText = isManual ? "Logged" : session.is_complete ? "Completed" : "In Progress";
      const firstReadBadge = session.is_first_read ? '<span class="first-read-badge">First Read</span>' : '';
      const sourceBadge =
        isManual && session.source
          ? `<span class="source-badge">${escapeHtml(session.source.replace(/_/g, " "))}</span>`
          : "";

      html += `
        <div class="history-item ${statusClass}" data-session-id="${session.id}">
          <div class="history-item-header">
            <span class="history-date">${speed.formatSessionDate(session.started_at)}</span>
            <span class="history-status ${statusClass}">${statusText}</span>
            ${firstReadBadge}
            ${sourceBadge}
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

    container.querySelectorAll(".btn-delete-session").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const sessionId = parseInt((btn as HTMLElement).dataset.sessionId!);

        const button = btn as HTMLButtonElement;
        if (button.disabled) return;
        button.disabled = true;
        button.textContent = "...";

        try {
          await speed.deleteReadingSession(sessionId);

          const item = container.querySelector(`.history-item[data-session-id="${sessionId}"]`);
          item?.remove();

          const remainingItems = container.querySelectorAll(".history-item");
          if (remainingItems.length === 0) {
            container.innerHTML = '<p class="empty-message">No reading sessions yet. Start reading to track your progress!</p>';
          }
        } catch (error) {
          console.error("Failed to delete session:", error);
          alert(`Failed to delete session: ${error}`);
          button.disabled = false;
          button.textContent = "×";
        }
      });
    });
  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load history: ${error}</p>`;
  }
}

async function loadInteractiveText(content: string, textId: number) {
  const container = document.getElementById("text-content-interactive");
  if (!container) return;

  setCurrentTextId(textId);

  try {
    const segments = await library.segmentText(content);

    setCurrentTextSegments(segments);

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
        html += segment.text.replace(/\n/g, "<br>");
      }
    }

    container.innerHTML = html;

    container.querySelectorAll(".text-segment").forEach((el) => {
      el.addEventListener("click", () => {
        const text = (el as HTMLElement).dataset.text!;
        const type = (el as HTMLElement).dataset.type!;

        document.querySelectorAll(".text-segment.selected").forEach(s => s.classList.remove("selected"));
        el.classList.add("selected");

        lookupInSidebar(text, type === "character" ? "character" : "word");
      });
    });

    container.addEventListener("mouseup", handleTextSelection);
  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load text: ${error}</p>`;
  }
}

function handleTextSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const selectedText = selection.toString().trim();
  if (!selectedText) return;

  const hasCjk = [...selectedText].some(isCjkCharacter);
  if (!hasCjk) return;

  const isAllCjk = [...selectedText].every(c => isCjkCharacter(c) || c === ' ' || c === '\n');
  if (!isAllCjk) return;

  const cleanedText = selectedText.replace(/\s+/g, '');
  if (cleanedText.length === 0) return;

  document.querySelectorAll(".text-segment.selected").forEach(s => s.classList.remove("selected"));

  lookupSelectedText(cleanedText);
}

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

    await renderSidebarResultsForSelection(result, selectedText, termType);
  } catch (error) {
    sidebarContent.innerHTML = `<p class="error">Lookup failed: ${error}</p>`;
  }
}

async function renderSidebarResultsForSelection(
  result: dictionary.LookupResult,
  selectedText: string,
  termType: "character" | "word"
) {
  const sidebarContent = document.getElementById("dict-sidebar-content");
  if (!sidebarContent) return;

  const hasEntries = result.entries.length > 0 || result.user_entries.length > 0;

  let html = `
    <div class="selection-header">
      <span class="selected-text">${escapeHtml(selectedText)}</span>
      <span class="selection-label">Selected text</span>
    </div>
  `;

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
    html += `<p class="dict-sidebar-empty">No dictionary entries found for "${escapeHtml(selectedText)}"</p>`;

    const characters = [...selectedText];
    if (characters.length > 1) {
      html += `<p class="dict-sidebar-char-breakdown-label">Character breakdown:</p>`;
      for (const char of characters) {
        try {
          const charResult = await dictionary.lookup(char, {
            includeExamples: false,
            includeCharacterInfo: true,
            includeUserDictionaries: true,
          });
          html += renderCharacterBreakdownEntry(char, charResult);
        } catch {
          html += `<div class="entry char-breakdown-entry"><span class="traditional" style="font-size: 1.5rem;">${escapeHtml(char)}</span> <span class="no-entry">(lookup failed)</span></div>`;
        }
      }
    }

    html += `
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

function setupAddAsWordButton() {
  document.querySelectorAll(".btn-add-as-word").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const word = (btn as HTMLElement).dataset.word!;

      (btn as HTMLButtonElement).textContent = "Adding...";
      (btn as HTMLButtonElement).disabled = true;

      try {
        await library.addCustomSegmentationWord(word, true, "known");
        (btn as HTMLButtonElement).textContent = "Added!";
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

function setupDefineWordForm(word: string, _termType: "character" | "word") {
  const form = document.getElementById("define-word-form") as HTMLFormElement;
  const shelfSpecificCheckbox = document.getElementById("define-shelf-specific") as HTMLInputElement;
  const shelfSelectorGroup = document.getElementById("shelf-selector-group") as HTMLDivElement;
  const shelfSelect = document.getElementById("define-shelf") as HTMLSelectElement;

  if (!form) return;

  loadShelvesForDefineForm(shelfSelect);

  shelfSpecificCheckbox?.addEventListener("change", () => {
    if (shelfSelectorGroup) {
      shelfSelectorGroup.style.display = shelfSpecificCheckbox.checked ? "block" : "none";
    }
  });

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
      await refreshCurrentText();
    } catch (error) {
      console.error("Failed to define word:", error);
      submitBtn.textContent = "Define & Add";
      submitBtn.disabled = false;
      alert(`Failed to define word: ${error}`);
    }
  });
}

async function loadShelvesForDefineForm(selectElement: HTMLSelectElement) {
  if (!selectElement) return;

  try {
    const shelves = await library.getShelfTree();
    const flatShelves = library.flattenShelfTree(shelves);

    let optionsHtml = '<option value="">Select a shelf...</option>';
    for (const node of flatShelves) {
      const depth = getShelfDepth(shelves, node.shelf.id);
      const indent = "—".repeat(depth);
      optionsHtml += `<option value="${node.shelf.id}">${indent}${escapeHtml(node.shelf.name)}</option>`;
    }

    selectElement.innerHTML = optionsHtml;

    if (selectedShelfId) {
      selectElement.value = selectedShelfId.toString();
    }
  } catch (error) {
    console.error("Failed to load shelves:", error);
    selectElement.innerHTML = '<option value="">Failed to load shelves</option>';
  }
}

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

async function refreshCurrentText() {
  if (!currentTextId) return;

  try {
    const text = await library.getText(currentTextId);
    await loadInteractiveText(text.content, currentTextId);
  } catch (error) {
    console.error("Failed to refresh text:", error);
  }
}

async function lookupInSidebar(term: string, termType: "character" | "word") {
  const sidebarContent = document.getElementById("dict-sidebar-content");
  if (!sidebarContent) return;

  document.getElementById("dict-sidebar")?.classList.add("open");
  sidebarContent.innerHTML = '<p class="loading">Looking up...</p>';

  try {
    const result = await dictionary.lookup(term, {
      includeExamples: true,
      includeCharacterInfo: termType === "character",
      includeUserDictionaries: true,
    });

    await renderSidebarResults(result, termType, "dict-sidebar-content");
  } catch (error) {
    sidebarContent.innerHTML = `<p class="error">Lookup failed: ${error}</p>`;
  }
}

async function lookupInShelfSidebar(term: string, termType: "character" | "word") {
  const sidebarContent = document.getElementById("shelf-dict-sidebar-content");
  if (!sidebarContent) return;

  document.getElementById("shelf-dict-sidebar")?.classList.add("open");
  sidebarContent.innerHTML = '<p class="loading">Looking up...</p>';

  try {
    const result = await dictionary.lookup(term, {
      includeExamples: true,
      includeCharacterInfo: termType === "character",
      includeUserDictionaries: true,
    });

    await renderSidebarResults(result, termType, "shelf-dict-sidebar-content");
  } catch (error) {
    sidebarContent.innerHTML = `<p class="error">Lookup failed: ${error}</p>`;
  }
}

function renderCharacterBreakdownEntry(char: string, charResult: dictionary.LookupResult): string {
  let html = `<div class="entry char-breakdown-entry">`;
  html += `<div class="entry-header">`;
  html += `<span class="traditional" style="font-size: 1.5rem;">${escapeHtml(char)}</span>`;

  if (charResult.entries.length > 0) {
    const entry = charResult.entries[0];
    html += ` <span class="pinyin">${dictionary.formatPinyin(entry)}</span>`;
  }
  html += `</div>`;

  if (charResult.character_info) {
    const info = charResult.character_info;
    const parts = [];
    if (info.radical) parts.push(`${info.radical} (#${info.radical_number})`);
    if (info.total_strokes) parts.push(`${info.total_strokes} strokes`);
    if (parts.length > 0) {
      html += `<div style="font-size: 0.8rem; color: #888;">${parts.join(" · ")}</div>`;
    }
  }

  if (charResult.entries.length > 0 && charResult.entries[0].definitions.length > 0) {
    const def = charResult.entries[0].definitions[0];
    html += `<div class="definitions"><div class="definition">`;
    if (def.part_of_speech) html += `<span class="pos">${def.part_of_speech}</span> `;
    html += `<span class="def-text">${def.text}</span>`;
    html += `</div></div>`;
  } else if (charResult.entries.length === 0) {
    html += `<div class="no-entry" style="font-size: 0.85rem; color: #888; font-style: italic;">No entry found</div>`;
  }

  html += `</div>`;
  return html;
}

async function renderSidebarResults(result: dictionary.LookupResult, termType: "character" | "word", containerId: string = "dict-sidebar-content") {
  const sidebarContent = document.getElementById(containerId);
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
    const characters = [...result.query];
    if (characters.length > 1) {
      html += `<p class="dict-sidebar-empty">No dictionary entries found for "${escapeHtml(result.query)}"</p>`;
      html += `<p class="dict-sidebar-char-breakdown-label">Character breakdown:</p>`;

      for (const char of characters) {
        try {
          const charResult = await dictionary.lookup(char, {
            includeExamples: false,
            includeCharacterInfo: true,
            includeUserDictionaries: true,
          });

          html += renderCharacterBreakdownEntry(char, charResult);
        } catch {
          html += `<div class="entry char-breakdown-entry"><span class="traditional" style="font-size: 1.5rem;">${escapeHtml(char)}</span> <span class="no-entry">(lookup failed)</span></div>`;
        }
      }

      sidebarContent.innerHTML = html;
      setupSidebarMarkKnown();
      return;
    }

    html += `<p class="dict-sidebar-empty">No dictionary entries found for "${escapeHtml(result.query)}"</p>`;
    sidebarContent.innerHTML = html;
    setupSidebarMarkKnown();
    return;
  }

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

function setupSidebarMarkKnown() {
  document.querySelectorAll(".btn-mark-known-sidebar").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const word = (btn as HTMLElement).dataset.word!;
      const wordType = (btn as HTMLElement).dataset.type!;

      (btn as HTMLButtonElement).textContent = "Marked as Known!";
      (btn as HTMLButtonElement).disabled = true;

      const learningBtn = btn.parentElement?.querySelector(".btn-mark-learning-sidebar") as HTMLButtonElement;
      if (learningBtn) learningBtn.disabled = true;

      try {
        await library.addKnownWord(word, wordType, "known");

        document.querySelectorAll(`.text-segment[data-text="${word}"]`).forEach(el => {
          el.classList.remove("unknown", "learning");
        });

        document.querySelectorAll(`.freq-item[data-lookup="${word}"]`).forEach(el => {
          el.classList.remove("unknown");
          el.classList.add("known");
          const itemBtn = el.querySelector(".btn-mark-known, .btn-mark-known-shelf");
          if (itemBtn) {
            itemBtn.outerHTML = '<span class="known-badge">Known</span>';
          }
        });
      } catch (error) {
        console.error("Failed to mark as known:", error);
        (btn as HTMLButtonElement).textContent = "Mark Known";
        (btn as HTMLButtonElement).disabled = false;
        if (learningBtn) learningBtn.disabled = false;
      }
    });
  });

  document.querySelectorAll(".btn-mark-learning-sidebar").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const word = (btn as HTMLElement).dataset.word!;
      const wordType = (btn as HTMLElement).dataset.type!;

      (btn as HTMLButtonElement).textContent = "Marked as Learning!";
      (btn as HTMLButtonElement).disabled = true;

      const knownBtn = btn.parentElement?.querySelector(".btn-mark-known-sidebar") as HTMLButtonElement;
      if (knownBtn) knownBtn.disabled = true;

      try {
        await library.addKnownWord(word, wordType, "learning");

        document.querySelectorAll(`.text-segment[data-text="${word}"]`).forEach(el => {
          el.classList.remove("unknown");
          el.classList.add("learning");
        });

        document.querySelectorAll(`.freq-item[data-lookup="${word}"]`).forEach(el => {
          el.classList.add("learning");
          const itemBtn = el.querySelector(".btn-mark-known, .btn-mark-known-shelf");
          if (itemBtn) {
            itemBtn.outerHTML = '<span class="learning-badge">Learning</span>';
          }
        });
      } catch (error) {
        console.error("Failed to mark as learning:", error);
        (btn as HTMLButtonElement).textContent = "Mark Learning";
        (btn as HTMLButtonElement).disabled = false;
        if (knownBtn) knownBtn.disabled = false;
      }
    });
  });
}

async function loadAnalysis(textId: number, sort: library.FrequencySort = currentSort) {
  const container = document.getElementById("analysis-container");
  if (!container) return;

  currentSort = sort;

  try {
    const report = await library.getAnalysisReport(textId, 20, sort);

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

    container.querySelectorAll(".sort-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const newSort = (btn as HTMLElement).dataset.sort as library.FrequencySort;
        loadAnalysis(textId, newSort);
      });
    });

    container.querySelectorAll(".btn-mark-known").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const word = (btn as HTMLElement).dataset.word!;
        const wordType = (btn as HTMLElement).dataset.type!;
        const freqItem = (btn as HTMLElement).closest(".freq-item");

        (btn as HTMLButtonElement).textContent = "Marked!";
        (btn as HTMLButtonElement).disabled = true;
        freqItem?.classList.remove("unknown");
        freqItem?.classList.add("known");

        try {
          await library.addKnownWord(word, wordType);
          btn.outerHTML = '<span class="known-badge">Known</span>';

          document.querySelectorAll(`.text-segment[data-text="${word}"]`).forEach(el => {
            el.classList.remove("unknown");
          });
        } catch (error) {
          console.error("Failed to mark as known:", error);
          (btn as HTMLButtonElement).textContent = "Mark Known";
          (btn as HTMLButtonElement).disabled = false;
          freqItem?.classList.add("unknown");
          freqItem?.classList.remove("known");
        }
      });
    });

    container.querySelectorAll(".freq-item[data-lookup]").forEach((item) => {
      item.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".btn-mark-known")) return;

        const term = (item as HTMLElement).dataset.lookup!;
        const termType = (item as HTMLElement).dataset.lookupType as "character" | "word";

        container.querySelectorAll(".freq-item").forEach(el => el.classList.remove("selected"));
        item.classList.add("selected");

        lookupInSidebar(term, termType);
      });
    });
  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load analysis: ${error}</p>`;
  }
}

function loadLearningItems() {
  const container = document.getElementById("learning-container");
  if (!container) return;

  const learningMap = new Map<string, { word: string; type: string; count: number }>();

  for (const segment of currentTextSegments) {
    if (segment.is_cjk && segment.is_learning) {
      const key = `${segment.text}:${segment.segment_type}`;
      const existing = learningMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        learningMap.set(key, {
          word: segment.text,
          type: segment.segment_type,
          count: 1,
        });
      }
    }
  }

  const learningItems = Array.from(learningMap.values()).sort((a, b) => b.count - a.count);

  if (learningItems.length === 0) {
    container.innerHTML = '<p class="empty-message">No learning items in this text.</p>';
    return;
  }

  const formatLearningItem = (item: { word: string; type: string; count: number }) => {
    const typeLabel = item.type === "character" ? "char" : "word";
    return `
      <div class="freq-item learning" data-lookup="${escapeHtml(item.word)}" data-lookup-type="${item.type}">
        <span class="freq-${typeLabel} freq-clickable">${item.word}</span>
        <span class="freq-count">${item.count}x</span>
        <span class="learning-badge">Learning</span>
      </div>
    `;
  };

  const learningChars = learningItems.filter(i => i.type === "character");
  const learningWords = learningItems.filter(i => i.type === "word");

  let html = `
    <div class="learning-summary">
      <p>Words and characters you're currently learning that appear in this text.</p>
    </div>

    <div class="analysis-sections">
  `;

  if (learningChars.length > 0) {
    html += `
      <div class="analysis-section">
        <h3>Learning Characters (${learningChars.length})</h3>
        <div class="freq-list">
          ${learningChars.map(formatLearningItem).join("")}
        </div>
      </div>
    `;
  }

  if (learningWords.length > 0) {
    html += `
      <div class="analysis-section">
        <h3>Learning Words (${learningWords.length})</h3>
        <div class="freq-list">
          ${learningWords.map(formatLearningItem).join("")}
        </div>
      </div>
    `;
  }

  html += `</div>`;

  container.innerHTML = html;

  container.querySelectorAll(".freq-item[data-lookup]").forEach((item) => {
    item.addEventListener("click", () => {
      const term = (item as HTMLElement).dataset.lookup!;
      const termType = (item as HTMLElement).dataset.lookupType as "character" | "word";

      container.querySelectorAll(".freq-item").forEach(el => el.classList.remove("selected"));
      item.classList.add("selected");

      lookupInSidebar(term, termType);
    });
  });
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
// Modals
// =============================================================================

function buildShelfPathMap(tree: library.ShelfTree[], prefix = ""): Map<number, string> {
  const map = new Map<number, string>();
  for (const node of tree) {
    const path = prefix ? `${prefix} › ${node.shelf.name}` : node.shelf.name;
    map.set(node.shelf.id, path);
    for (const [id, childPath] of buildShelfPathMap(node.children, path)) {
      map.set(id, childPath);
    }
  }
  return map;
}

async function showOfflineLogModal() {
  const selectedTexts: Map<number, { id: number; title: string; character_count: number }> = new Map();
  let selectedSource: string | null = null;

  // Pre-populate the currently open text
  if (currentTextId) {
    try {
      const currentText = await library.getText(currentTextId);
      selectedTexts.set(currentTextId, {
        id: currentTextId,
        title: currentText.title,
        character_count: currentText.character_count,
      });
    } catch { /* ignore */ }
  }

  // Build shelf path map for disambiguating search results
  const shelfPathMap = buildShelfPathMap(shelfTree);

  // Default finished_at to now (datetime-local format)
  const now = new Date();
  const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);

  const modalContent = `
    <div class="offline-log-form">
      <div>
        <label class="form-label">Texts you read</label>
        <div id="chip-list" class="text-chip-list"></div>
        <input
          type="text"
          id="text-search"
          class="text-search-input"
          placeholder="🔍 Search texts to add…"
          autocomplete="off"
        />
        <div id="text-search-results" class="text-search-results"></div>
      </div>

      <div>
        <label class="form-label">When did you finish?</label>
        <input type="datetime-local" id="finished-at" value="${localIso}" />
      </div>

      <div>
        <label class="form-label">Total reading time</label>
        <div class="duration-row">
          <div>
            <input type="number" id="duration-hours" min="0" max="23" value="0" placeholder="hrs" />
          </div>
          <div>
            <input type="number" id="duration-minutes" min="0" max="59" value="30" placeholder="min" />
          </div>
        </div>
      </div>

      <div>
        <label class="form-label">Where did you read?</label>
        <div class="source-chips">
          <button class="source-chip" data-source="physical_book">Physical book</button>
          <button class="source-chip" data-source="other_site">Other site</button>
          <button class="source-chip" data-source="phone">Phone (no app)</button>
          <button class="source-chip" data-source="other">Other</button>
        </div>
      </div>

      <div class="form-actions">
        <button type="button" class="btn-secondary modal-cancel">Cancel</button>
        <button type="button" id="offline-save-btn" class="btn-primary" disabled>Save 0 sessions</button>
      </div>
    </div>
  `;

  const modal = createModal("Log offline reading", modalContent);

  function refreshChips() {
    const chipList = modal.querySelector("#chip-list")!;
    chipList.innerHTML = [...selectedTexts.values()]
      .map(
        (t) => `
        <div class="text-chip" data-chip-id="${t.id}">
          <span class="text-chip-name">${escapeHtml(t.title)}</span>
          <button class="text-chip-remove" data-remove-id="${t.id}">×</button>
        </div>
      `
      )
      .join("");
    chipList.querySelectorAll(".text-chip-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedTexts.delete(parseInt((btn as HTMLElement).dataset.removeId!));
        refreshChips();
        updateSaveLabel();
      });
    });
  }

  function updateSaveLabel() {
    const saveBtn = modal.querySelector("#offline-save-btn") as HTMLButtonElement | null;
    if (saveBtn) {
      const n = selectedTexts.size;
      saveBtn.textContent = `Save ${n} session${n !== 1 ? "s" : ""}`;
      saveBtn.disabled = n === 0;
    }
  }

  modal.querySelectorAll(".source-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      modal.querySelectorAll(".source-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      selectedSource = (chip as HTMLElement).dataset.source || null;
    });
  });

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  const searchInput = modal.querySelector("#text-search") as HTMLInputElement;
  const resultsEl = modal.querySelector("#text-search-results") as HTMLElement;

  searchInput.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = searchInput.value.trim();
      if (q.length < 1) { resultsEl.classList.remove("open"); return; }
      const results = await library.searchTexts(q);
      resultsEl.innerHTML = results
        .filter((r) => !selectedTexts.has(r.id))
        .map((r) => {
          const shelfPath = shelfPathMap.get(r.shelf_id) || "";
          return `<div class="text-search-result-item" data-id="${r.id}" data-title="${escapeHtml(r.title)}" data-chars="${r.character_count}">
            <span class="result-title">${escapeHtml(r.title)}</span>
            ${shelfPath ? `<span class="result-shelf">${escapeHtml(shelfPath)}</span>` : ""}
          </div>`;
        })
        .join("") || `<div class="text-search-result-item" style="color:var(--muted)">No results</div>`;
      resultsEl.classList.add("open");
    }, 250);
  });

  resultsEl.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(".text-search-result-item") as HTMLElement | null;
    if (!item || !item.dataset.id) return;
    const id = parseInt(item.dataset.id);
    selectedTexts.set(id, {
      id,
      title: item.dataset.title || "",
      character_count: parseInt(item.dataset.chars || "0"),
    });
    searchInput.value = "";
    resultsEl.classList.remove("open");
    refreshChips();
    updateSaveLabel();
  });

  const outsideClickAbort = new AbortController();

  document.addEventListener(
    "click",
    (e) => {
      if (!searchInput.contains(e.target as Node) && !resultsEl.contains(e.target as Node)) {
        resultsEl.classList.remove("open");
      }
    },
    { signal: outsideClickAbort.signal }
  );

  const removalObserver = new MutationObserver(() => {
    if (!document.contains(modal)) {
      outsideClickAbort.abort();
      removalObserver.disconnect();
    }
  });
  removalObserver.observe(document.body, { childList: true });

  const saveBtn = modal.querySelector("#offline-save-btn") as HTMLButtonElement;
  saveBtn.addEventListener("click", async () => {
    await saveOfflineLog(modal, selectedTexts, selectedSource);
  });

  updateSaveLabel();
}

async function saveOfflineLog(
  modal: HTMLElement,
  selectedTexts: Map<number, { id: number; title: string; character_count: number }>,
  source: string | null
) {
  const finishedAtInput = modal.querySelector("#finished-at") as HTMLInputElement;
  const hoursInput = modal.querySelector("#duration-hours") as HTMLInputElement;
  const minutesInput = modal.querySelector("#duration-minutes") as HTMLInputElement;

  const hours = parseInt(hoursInput.value) || 0;
  const minutes = parseInt(minutesInput.value) || 0;
  const totalSeconds = hours * 3600 + minutes * 60;

  if (totalSeconds <= 0) {
    alert("Please enter a reading duration.");
    return;
  }
  if (selectedTexts.size === 0) {
    alert("Please add at least one text.");
    return;
  }

  const localDt = new Date(finishedAtInput.value);
  const finishedAt = localDt.toISOString();

  try {
    await speed.logOfflineRead({
      text_ids: [...selectedTexts.keys()],
      finished_at: finishedAt,
      total_duration_seconds: totalSeconds,
      source,
    });
    closeModal();
    if (currentTextId) await loadReadingHistory(currentTextId);
    await loadShelfTree();
  } catch (err) {
    console.error("Failed to log offline read:", err);
    alert("Failed to save. Please try again.");
  }
}

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

  const excludeIds = getShelfAndDescendantIds(shelfTree, shelfId);
  const shelfOpts = renderShelfOptionsExcluding(shelfTree, 0, excludeIds, shelf.parent_id);

  const modal = createModal("Move Shelf", `
    <form id="move-shelf-form">
      <div class="form-group">
        <p>Move <strong>${escapeHtml(shelf.name)}</strong> to:</p>
      </div>
      <div class="form-group">
        <label for="new-parent-shelf">New Parent Shelf</label>
        <select id="new-parent-shelf">
          <option value="">None (root level)</option>
          ${shelfOpts}
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
    setSelectedShelfId(null);
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

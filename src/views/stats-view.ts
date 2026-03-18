import * as library from "../lib/library";
import * as speed from "../lib/speed";

// =============================================================================
// Stats View (Reading Volume & Streak)
// =============================================================================

let currentStatsPeriod: 30 | 90 | 365 = 30;

export async function loadStatsView() {
  const container = document.getElementById("stats-main");
  if (!container) return;

  container.innerHTML = '<p class="loading">Loading stats...</p>';

  try {
    const [volumeData, streak] = await Promise.all([
      speed.getDailyReadingVolume(currentStatsPeriod),
      speed.getReadingStreak(),
    ]);

    const totalChars = volumeData.reduce((sum, d) => sum + d.characters_read, 0);
    const totalMinutes = Math.round(volumeData.reduce((sum, d) => sum + d.reading_seconds, 0) / 60);
    const totalSessions = volumeData.reduce((sum, d) => sum + d.sessions_count, 0);
    const daysWithReading = volumeData.length;

    let html = `
      <div class="stats-view">
        <div class="stats-header">
          <h2>Reading Stats</h2>
          <div class="stats-period-filter">
            <label for="stats-period">Period:</label>
            <select id="stats-period">
              <option value="30" ${currentStatsPeriod === 30 ? "selected" : ""}>Last 30 Days</option>
              <option value="90" ${currentStatsPeriod === 90 ? "selected" : ""}>Last 90 Days</option>
              <option value="365" ${currentStatsPeriod === 365 ? "selected" : ""}>Last Year</option>
            </select>
          </div>
        </div>

        <div class="streak-banner ${streak.current_streak > 0 ? "active" : ""}">
          <div class="streak-flame">${streak.current_streak > 0 ? "🔥" : "💤"}</div>
          <div class="streak-info">
            <span class="streak-count">${streak.current_streak}</span>
            <span class="streak-label">Day${streak.current_streak !== 1 ? "s" : ""} Streak</span>
          </div>
          <div class="streak-details">
            <span class="streak-detail">Longest: ${streak.longest_streak} day${streak.longest_streak !== 1 ? "s" : ""}</span>
            <span class="streak-detail">${streak.read_today ? "Read today ✓" : "Not read today"}</span>
          </div>
        </div>

        <div class="stats-summary">
          <div class="stat-card">
            <span class="stat-value">${library.formatCharacterCount(totalChars)}</span>
            <span class="stat-label">Characters</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${formatMinutes(totalMinutes)}</span>
            <span class="stat-label">Reading Time</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${totalSessions}</span>
            <span class="stat-label">Sessions</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${daysWithReading}</span>
            <span class="stat-label">Days Active</span>
          </div>
        </div>

        <div class="volume-chart-section">
          <h3>Reading Volume Over Time</h3>
          ${renderVolumeChart(volumeData, currentStatsPeriod)}
        </div>

        <div class="daily-breakdown-section">
          <h3>Recent Activity</h3>
          ${renderDailyBreakdown(volumeData)}
        </div>
      </div>
    `;

    container.innerHTML = html;
    setupStatsViewHandlers();

  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load stats: ${error}</p>`;
  }
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes > 0) {
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${hours}h`;
}

function renderVolumeChart(data: speed.DailyReadingVolume[], periodDays: number): string {
  if (data.length === 0) {
    return '<p class="empty-message">No reading data yet. Start reading to track your progress!</p>';
  }

  const dataMap = new Map(data.map(d => [d.date, d]));

  const dates: string[] = [];
  const today = new Date();
  for (let i = periodDays - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    dates.push(date.toISOString().split("T")[0]);
  }

  const maxChars = Math.max(...data.map(d => d.characters_read), 1);
  const maxMinutes = Math.max(...data.map(d => Math.ceil(d.reading_seconds / 60)), 1);

  const barWidth = periodDays <= 30 ? "calc(100% / 30 - 2px)" :
                   periodDays <= 90 ? "calc(100% / 90 - 1px)" :
                   "calc(100% / 365)";

  const barsHtml = dates.map(date => {
    const dayData = dataMap.get(date);
    const chars = dayData?.characters_read ?? 0;
    const minutes = dayData ? Math.ceil(dayData.reading_seconds / 60) : 0;
    const charHeight = (chars / maxChars) * 100;
    const minuteHeight = (minutes / maxMinutes) * 100;

    const dateObj = new Date(date + "T00:00:00");
    const dayLabel = dateObj.toLocaleDateString(undefined, { month: "short", day: "numeric" });

    return `
      <div class="volume-bar-group" style="width: ${barWidth};" title="${dayLabel}: ${library.formatCharacterCount(chars)} chars, ${minutes}min">
        <div class="volume-bar chars-bar" style="height: ${charHeight}%;"></div>
        <div class="volume-bar minutes-bar" style="height: ${minuteHeight}%;"></div>
      </div>
    `;
  }).join("");

  return `
    <div class="volume-chart-container">
      <div class="volume-chart-legend">
        <span class="legend-item"><span class="legend-color chars-color"></span> Characters</span>
        <span class="legend-item"><span class="legend-color minutes-color"></span> Minutes</span>
      </div>
      <div class="volume-chart">
        <div class="volume-bars">
          ${barsHtml}
        </div>
      </div>
      <div class="volume-chart-labels">
        <span>${dates[0]}</span>
        <span>${dates[dates.length - 1]}</span>
      </div>
    </div>
  `;
}

function renderDailyBreakdown(data: speed.DailyReadingVolume[]): string {
  if (data.length === 0) {
    return '<p class="empty-message">No reading sessions recorded yet.</p>';
  }

  const recent = [...data].reverse().slice(0, 14);

  let html = '<div class="daily-breakdown-list">';

  for (const day of recent) {
    const dateObj = new Date(day.date + "T00:00:00");
    const dateLabel = dateObj.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const minutes = Math.round(day.reading_seconds / 60);

    html += `
      <div class="daily-breakdown-item">
        <div class="daily-date">${dateLabel}</div>
        <div class="daily-stats">
          <span class="daily-chars">${library.formatCharacterCount(day.characters_read)} chars</span>
          <span class="daily-time">${formatMinutes(minutes)}</span>
          <span class="daily-sessions">${day.sessions_count} session${day.sessions_count !== 1 ? "s" : ""}</span>
        </div>
      </div>
    `;
  }

  html += "</div>";
  return html;
}

function setupStatsViewHandlers() {
  document.getElementById("stats-period")?.addEventListener("change", async (e) => {
    const value = parseInt((e.target as HTMLSelectElement).value);
    currentStatsPeriod = value as 30 | 90 | 365;
    await loadStatsView();
  });
}

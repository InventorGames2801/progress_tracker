/* ============================================
   PROGRESS TRACKER — APPLICATION LOGIC
   State management, localStorage, CRUD, rendering
   ============================================ */

// ============ CONSTANTS ============
const STORAGE_KEY = 'progressTrackerState';
const SETTINGS_PASSWORD = '2801040094545';
const LOGS_PASSWORD = '0094545280104';
const RECENT_LOGS_COUNT = 5;

// ============ DEFAULT STATE ============
function getDefaultState() {
  return {
    goalTitle: '',
    goalTarget: 0,
    goalCurrent: 0,
    goalUnit: 'очков',
    goalColor: '#6366f1',
    goalStartDate: '',
    subGoals: [],
    logs: [],
    cloudConfig: {
      githubToken: '',
      gistId: '',
      lastSyncedAt: null,
      pendingSync: false
    }
  };
}


// ============ STATE ============
let state = getDefaultState();
let pendingPointsData = null;
let passwordCallback = null;
let editingLogId = null;

// ============ UTILITY FUNCTIONS ============
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' +
         d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function daysSince(dateStr) {
  if (!dateStr) return 0;
  const start = new Date(dateStr);
  const now = new Date();
  const diff = now - start;
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function linkifyText(text) {
  // Преобразует URL в кликабельные ссылки
  const urlRegex = /(https?:\/\/[^\s<]+)/g;
  return escapeHtml(text).replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function formatNumber(num) {
  return new Intl.NumberFormat('ru-RU').format(num);
}

// ============ LOCALSTORAGE & CLOUD SYNC ============
function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      state = { ...getDefaultState(), ...parsed, cloudConfig: { ...getDefaultState().cloudConfig, ...(parsed.cloudConfig || {}) } };
      console.log('[Storage:Local] Состояние загружено из localStorage:', state);
    } else {
      console.log('[Storage:Local] Сохранённого состояния в localStorage нет, используются значения по умолчанию');
    }
  } catch (e) {
    console.error('[Storage:Local] Ошибка загрузки из localStorage:', e);
    state = getDefaultState();
  }

  // Загружаем с GitHub при наличии сетевого соединения и настроенного облака
  if (state.cloudConfig && state.cloudConfig.githubToken && state.cloudConfig.gistId && navigator.onLine) {
    loadFromCloud();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    console.log('[Storage:Local] Состояние сохранено в localStorage');
  } catch (e) {
    console.error('[Storage:Local] Ошибка сохранения в localStorage:', e);
    showToast('Ошибка сохранения локальных данных', 'error');
  }

  // Если настроена синхронизация с GitHub Cloud
  if (state.cloudConfig && state.cloudConfig.githubToken && state.cloudConfig.gistId) {
    if (navigator.onLine) {
      syncToCloud();
    } else {
      state.cloudConfig.pendingSync = true;
      console.warn('[Storage:Offline] Нет интернет-соединения. Данные сохранены локально и будут отправлены при появлении сети.');
    }
  }
}

// ============ GITHUB CLOUD SYNC (GIST API) ============
function getAuthHeader(token) {
  if (!token) return '';
  const t = token.trim();
  if (t.startsWith('token ') || t.startsWith('Bearer ')) return t;
  if (t.startsWith('ghp_') || t.startsWith('gist_')) return `token ${t}`;
  return `Bearer ${t}`;
}

// Удаляем чувствительные данные перед отправкой в Gist
function getSanitizedState() {
  const safeState = JSON.parse(JSON.stringify(state));
  if (safeState.cloudConfig) {
    // Удаляем токен, чтобы GitHub Secret Scanning не отзывал его
    delete safeState.cloudConfig.githubToken;
  }
  return safeState;
}

async function syncToCloud() {
  const tokenInput = document.getElementById('settCloudToken')?.value.trim();
  const gistIdInput = document.getElementById('settCloudGistId')?.value.trim();

  // Обновляем токен и Gist ID из полей ввода, если они переданы
  if (!state.cloudConfig) state.cloudConfig = {};
  if (tokenInput) state.cloudConfig.githubToken = tokenInput;
  if (gistIdInput) state.cloudConfig.gistId = gistIdInput;

  const { githubToken, gistId } = state.cloudConfig;

  if (!githubToken) {
    showToast('Введите GitHub Personal Access Token', 'error');
    return;
  }

  // Если Gist ID нет (например, на новом устройстве) — ищем существующее облако на GitHub
  if (!gistId) {
    console.log('[Storage:Cloud] 🔍 Gist ID не найден. Поиск существующего хранилища в аккаунте GitHub...');
    showToast('Поиск вашего облака на GitHub...', 'success');
    const foundId = await autoDiscoverGist(githubToken);
    if (foundId) {
      state.cloudConfig.gistId = foundId;
      await loadFromCloud();
      saveState();
      renderSettingsContent();
      render();
      showToast('Успешно подключено к вашему облаку!', 'success');
      return;
    } else {
      showToast('Облако не найдено. Нажмите "Создать облако"', 'error');
      renderCloudStatusBox('Облако не найдено в аккаунте. Создайте новое кнопкой ниже.');
      return;
    }
  }

  console.log(`[Storage:Cloud] 🚀 Начало отправки данных в GitHub Gist (ID: ${gistId})...`);
  showToast('Синхронизация с GitHub...', 'success');

  try {
    // Сначала пробуем загрузить свежие данные с облака
    await loadFromCloud();

    const payload = {
      description: "Progress Tracker Backup Data",
      files: {
        "progress_tracker_state.json": {
          content: JSON.stringify(getSanitizedState(), null, 2)
        }
      }
    };

    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': getAuthHeader(githubToken),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      state.cloudConfig.lastSyncedAt = new Date().toISOString();
      state.cloudConfig.pendingSync = false;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      console.log(`[Storage:Cloud] ✅ Успешно синхронизировано с GitHub Gist (Status ${response.status} OK). Время: ${formatDateTime(state.cloudConfig.lastSyncedAt)}`);
      renderCloudStatusBox();
      showToast('Синхронизировано с GitHub!', 'success');
    } else {
      const errText = await response.text();
      console.error(`[Storage:Cloud] ❌ Ошибка Gist API (${response.status}):`, errText);
      renderCloudStatusBox(`Ошибка ${response.status}: Проверьте токен или Gist ID`);
      showToast(`Ошибка ${response.status}: неверный токен`, 'error');
    }
  } catch (e) {
    console.error('[Storage:Cloud] ❌ Сетевая ошибка при синхронизации с облаком:', e);
    state.cloudConfig.pendingSync = true;
    renderCloudStatusBox('Ошибка сети. Данные сохранены локально.');
    showToast('Ошибка сети при синхронизации', 'error');
  }
}

async function autoDiscoverGist(token) {
  try {
    const response = await fetch('https://api.github.com/gists', {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': getAuthHeader(token)
      }
    });

    if (response.ok) {
      const gists = await response.json();
      const trackerGist = gists.find(g => g.files && g.files['progress_tracker_state.json']);
      if (trackerGist) {
        console.log(`[Storage:Cloud] 🎉 Найдено существующее облако! Gist ID: ${trackerGist.id}`);
        return trackerGist.id;
      }
    } else {
      console.warn(`[Storage:Cloud] ⚠️ Ошибка поиска Gists (Status ${response.status})`);
    }
  } catch (e) {
    console.error('[Storage:Cloud] ❌ Ошибка сети при поиске Gist:', e);
  }
  return null;
}

async function createCloudGist() {
  const tokenInput = document.getElementById('settCloudToken');
  const token = tokenInput ? tokenInput.value.trim() : '';

  if (!token) {
    showToast('Введите GitHub Personal Access Token', 'error');
    return;
  }

  // Сначала проверяем, вдруг облако уже существует в этом аккаунте
  const existingId = await autoDiscoverGist(token);
  if (existingId) {
    if (!state.cloudConfig) state.cloudConfig = {};
    state.cloudConfig.githubToken = token;
    state.cloudConfig.gistId = existingId;
    await loadFromCloud();
    saveState();
    renderSettingsContent();
    render();
    showToast('Найдено существующее облако! Данные загружены.', 'success');
    return;
  }

  console.log('[Storage:Cloud] ⚙️ Запрос на создание нового секретного Gist на GitHub...');
  showToast('Создание хранилища на GitHub...', 'success');

  try {
    const payload = {
      description: "Progress Tracker Secret Backup",
      public: false,
      files: {
        "progress_tracker_state.json": {
          content: JSON.stringify(getSanitizedState(), null, 2)
        }
      }
    };

    const response = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': getAuthHeader(token),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      if (!state.cloudConfig) state.cloudConfig = {};
      state.cloudConfig.githubToken = token;
      state.cloudConfig.gistId = data.id;
      state.cloudConfig.lastSyncedAt = new Date().toISOString();
      state.cloudConfig.pendingSync = false;

      saveState();
      renderSettingsContent();
      render();
      console.log(`[Storage:Cloud] 🎉 Секретный Gist успешно создан! Gist ID: ${data.id}`);
      showToast('Облачное хранилище создано на GitHub!');
    } else {
      const errText = await response.text();
      console.error(`[Storage:Cloud] ❌ Ошибка создания Gist (${response.status}):`, errText);
      showToast(`Ошибка ${response.status}: Проверьте токен GitHub`, 'error');
    }
  } catch (e) {
    console.error('[Storage:Cloud] ❌ Ошибка сети при создании Gist:', e);
    showToast('Ошибка сети при подключении к GitHub', 'error');
  }
}

async function loadFromCloud() {
  const { githubToken, gistId } = state.cloudConfig || {};
  if (!githubToken || !gistId || !navigator.onLine) return;

  console.log(`[Storage:Cloud] 🔄 Проверка и загрузка актуального состояния с GitHub (Gist ID: ${gistId})...`);
  try {
    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': getAuthHeader(githubToken)
      }
    });

    if (response.ok) {
      const data = await response.json();
      const file = data.files && data.files['progress_tracker_state.json'];
      if (file && file.content) {
        const remoteState = JSON.parse(file.content);
        console.log('[Storage:Cloud] 📥 Получено удаленное состояние с GitHub:', remoteState);

        state = { ...getDefaultState(), ...remoteState, cloudConfig: { ...state.cloudConfig, lastSyncedAt: new Date().toISOString() } };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        render();
        console.log('[Storage:Cloud] ✅ Данные успешно синхронизированы с GitHub!');
      }
    } else {
      console.warn(`[Storage:Cloud] ⚠️ Не удалось загрузить облачные данные (Status ${response.status})`);
    }
  } catch (e) {
    console.error('[Storage:Cloud] ❌ Ошибка при получении данных с GitHub:', e);
  }
}

function renderCloudStatusBox(errorMessage = '') {
  const box = document.getElementById('cloudStatusBox');
  if (!box) return;

  const { githubToken, gistId, lastSyncedAt, pendingSync } = state.cloudConfig || {};

  if (!githubToken || !gistId) {
    box.innerHTML = `
      <div style="color: #fbbf24; font-weight: 500;">⚠️ Облачная синхронизация не настроена</div>
      <div style="color: var(--text-muted); font-size: 0.78rem; margin-top: 4px;">
        Введите Personal Access Token и нажмите "Создать облако на GitHub", чтобы начать безопасное хранение.
      </div>
    `;
    return;
  }

  if (errorMessage) {
    box.innerHTML = `
      <div style="color: #f87171; font-weight: 500;">❌ Статус: Ошибка</div>
      <div style="color: #fca5a5; font-size: 0.78rem; margin-top: 4px;">${escapeHtml(errorMessage)}</div>
    `;
    return;
  }

  if (!navigator.onLine) {
    box.innerHTML = `
      <div style="color: #fbbf24; font-weight: 500;">📡 Оффлайн-режим (Нет сети)</div>
      <div style="color: var(--text-muted); font-size: 0.78rem; margin-top: 4px;">
        Данные сохраняются локально. Синхронизация с GitHub произойдет при подключении к сети.
      </div>
    `;
    return;
  }

  box.innerHTML = `
    <div style="color: #34d399; font-weight: 500;">✅ Статус: Подключено к GitHub Gist</div>
    <div style="color: var(--text-muted); font-size: 0.78rem; margin-top: 4px;">
      Gist ID: <code style="font-family: monospace;">${escapeHtml(gistId)}</code><br>
      Последняя синхронизация: ${lastSyncedAt ? formatDateTime(lastSyncedAt) : 'Только что'}<br>
      ${pendingSync ? '<span style="color: #fbbf24;">Есть локальные изменения для отправки...</span>' : '<span style="color: #34d399;">Все данные синхронизированы</span>'}
    </div>
  `;
}

// ============ TOAST NOTIFICATIONS ============
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  console.log(`[Toast] ${type}: ${message}`);

  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease-out forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============ MAIN RENDER ============
function render() {
  console.log('[Render] Обновление интерфейса...');
  const isConfigured = state.goalTitle && state.goalTarget > 0;

  const welcomeState = document.getElementById('welcomeState');
  const goalContent = document.getElementById('goalContent');

  if (isConfigured) {
    welcomeState.classList.add('hidden');
    goalContent.classList.remove('hidden');
    renderMainProgress();
    renderSubGoals();
    renderRecentLogs();
    renderSubGoalSelect();
  } else {
    welcomeState.classList.remove('hidden');
    goalContent.classList.add('hidden');
  }
}

// ============ MAIN PROGRESS BAR ============
function renderMainProgress() {
  const { goalTitle, goalTarget, goalCurrent, goalUnit, goalColor, goalStartDate } = state;
  const remaining = Math.max(0, goalTarget - goalCurrent);
  const percent = goalTarget > 0 ? clamp((goalCurrent / goalTarget) * 100, 0, 100) : 0;
  const days = daysSince(goalStartDate);

  // Заголовок
  document.getElementById('goalTitleDisplay').textContent = goalTitle;

  // Оставшееся
  document.getElementById('remainingValue').textContent = formatNumber(remaining);
  document.getElementById('remainingUnit').textContent = goalUnit;

  // Прогресс-бар
  const fill = document.getElementById('progressFill');
  const glow = document.getElementById('progressGlow');
  fill.style.width = percent + '%';
  glow.style.width = percent + '%';

  // Цвет прогресс-бара
  const gradient = `linear-gradient(135deg, ${goalColor} 0%, ${adjustColor(goalColor, 40)} 50%, ${adjustColor(goalColor, 70)} 100%)`;
  fill.style.background = gradient;
  glow.style.background = gradient;
  fill.style.boxShadow = `0 0 20px ${goalColor}66`;

  // Класс завершения
  if (percent >= 100) {
    fill.classList.add('complete');
  } else {
    fill.classList.remove('complete');
  }

  // Процент
  document.getElementById('progressPercent').textContent = percent.toFixed(1) + '%';

  // Статистика
  document.getElementById('statCurrent').textContent = formatNumber(goalCurrent);
  document.getElementById('statTarget').textContent = formatNumber(goalTarget);
  document.getElementById('statRemaining').textContent = formatNumber(remaining);
  document.getElementById('statDays').textContent = days;

  console.log(`[Progress] ${goalCurrent}/${goalTarget} (${percent.toFixed(1)}%), осталось ${remaining} ${goalUnit}`);
}

function adjustColor(hex, amount) {
  // Осветление/изменение цвета
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  r = Math.min(255, r + amount);
  g = Math.min(255, g + amount);
  b = Math.min(255, b + amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ============ SUBGOALS RENDERING ============
function renderSubGoals() {
  const grid = document.getElementById('subGoalsGrid');
  const section = document.getElementById('subGoalsSection');
  const completedGrid = document.getElementById('completedSubGoalsGrid');
  const completedSection = document.getElementById('completedSubGoalsSection');

  const activeSubGoals = state.subGoals.filter(sg => (sg.current || 0) < sg.target);
  const completedSubGoals = state.subGoals.filter(sg => (sg.current || 0) >= sg.target);

  if (activeSubGoals.length === 0) {
    section.classList.add('hidden');
  } else {
    section.classList.remove('hidden');
    grid.innerHTML = activeSubGoals.map(sg => renderSubGoalCard(sg, false)).join('');
  }

  if (completedSubGoals.length === 0) {
    completedSection.classList.add('hidden');
  } else {
    completedSection.classList.remove('hidden');
    completedGrid.innerHTML = completedSubGoals.map(sg => renderSubGoalCard(sg, true)).join('');
  }

  console.log(`[SubGoals] Отрисовано ${activeSubGoals.length} активных и ${completedSubGoals.length} завершённых подзадач`);
}

function renderSubGoalCard(sg, isCompleted) {
  const currentVal = sg.current || 0;
  const percent = sg.target > 0 ? clamp((currentVal / sg.target) * 100, 0, 100) : 0;
  const remaining = Math.max(0, sg.target - currentVal);
  const days = daysSince(sg.createdAt);
  const circumference = 2 * Math.PI * 24; // r=24
  const offset = circumference * (1 - percent / 100);
  const color = sg.color || '#6366f1';
  
  const descText = sg.description ? sg.description.trim() : '';
  const hasDesc = descText.length > 0;
  const lineCount = (descText.match(/\n/g) || []).length + 1;
  const isLongDesc = hasDesc && (lineCount > 3 || descText.length > 100);
  const hasReward = sg.reward && sg.reward.trim().length > 0;

  return `
    <div class="subgoal-card ${isCompleted ? 'completed' : ''}">
      ${sg.image
        ? `<img class="subgoal-card-image" src="${sg.image}" alt="${escapeHtml(sg.title)}" loading="lazy">`
        : `<div class="subgoal-card-image-placeholder">🎯</div>`
      }
      <div class="subgoal-card-body">
        <div class="subgoal-card-header">
          <div class="subgoal-card-title">${escapeHtml(sg.title)}</div>
          <div class="circular-progress">
            <svg viewBox="0 0 56 56">
              <circle class="bg-circle" cx="28" cy="28" r="24"/>
              <circle class="fg-circle" cx="28" cy="28" r="24"
                stroke="${color}"
                stroke-dasharray="${circumference}"
                stroke-dashoffset="${offset}"/>
            </svg>
            <span class="progress-text">${Math.round(percent)}%</span>
          </div>
        </div>
        <div class="subgoal-stats">
          <div class="subgoal-stat">Цель: <span class="subgoal-stat-value">${formatNumber(sg.target)}</span></div>
          <div class="subgoal-stat">Набрано: <span class="subgoal-stat-value">${formatNumber(currentVal)}</span></div>
          <div class="subgoal-stat">Осталось: <span class="subgoal-stat-value">${formatNumber(remaining)}</span></div>
          <div class="subgoal-stat">Дней: <span class="subgoal-stat-value">${days}</span></div>
        </div>
        ${hasDesc ? (isLongDesc ? `
          <div class="subgoal-description collapsed" onclick="toggleDescription(this)" title="Нажмите чтобы развернуть">${linkifyText(descText)}</div>
          <span class="expand-hint">▼ нажмите для подробностей</span>
        ` : `
          <div class="subgoal-description">${linkifyText(descText)}</div>
        `) : ''}
        ${(isCompleted && hasReward) ? `
          <div class="reward-block"><strong>🎁 Награда:</strong><br>${linkifyText(sg.reward)}</div>
        ` : ''}
      </div>
    </div>
  `;
}

function toggleDescription(el) {
  const hint = el.nextElementSibling;
  if (el.classList.contains('collapsed')) {
    el.classList.remove('collapsed');
    el.classList.add('expanded');
    if (hint) hint.textContent = '▲ свернуть';
  } else {
    el.classList.remove('expanded');
    el.classList.add('collapsed');
    if (hint) hint.textContent = '▼ нажмите для подробностей';
  }
}

// ============ RECENT LOGS ============
function renderRecentLogs() {
  const list = document.getElementById('recentLogsList');
  const recentLogs = state.logs.slice(-RECENT_LOGS_COUNT).reverse();

  if (recentLogs.length === 0) {
    list.innerHTML = '<div class="logs-empty">Пока нет записей. Добавьте прогресс!</div>';
    return;
  }

  list.innerHTML = recentLogs.map(log => {
    const subGoal = log.subGoalId ? state.subGoals.find(sg => sg.id === log.subGoalId) : null;
    return `
      <div class="recent-log-item">
        <span class="log-date">${formatDateTime(log.date)}</span>
        <span class="log-points">+${formatNumber(log.points)}</span>
        ${subGoal ? `<span class="log-subgoal-badge">${escapeHtml(subGoal.title)}</span>`
                  : (log.subGoalTitle ? `<span class="log-subgoal-badge" style="opacity:0.5">${escapeHtml(log.subGoalTitle)}</span>` : '')}
        <span class="log-description" title="${escapeHtml(log.description || '')}">${escapeHtml(log.description || '—')}</span>
      </div>
    `;
  }).join('');

  console.log(`[Logs] Показано ${recentLogs.length} последних записей`);
}

// ============ SUBGOAL SELECT (for adding points) ============
function renderSubGoalSelect() {
  const select = document.getElementById('subGoalSelect');
  const currentVal = select.value;
  select.innerHTML = '<option value="">Без подзадачи</option>' +
    state.subGoals.map(sg => `<option value="${sg.id}">${escapeHtml(sg.title)}</option>`).join('');
  select.value = currentVal;
}

// ============ ADD POINTS PANEL ============
function toggleAddPointsPanel() {
  const panel = document.getElementById('addPointsPanel');
  const btn = document.getElementById('addPointsToggle');
  const isHidden = panel.classList.contains('hidden');

  if (isHidden) {
    panel.classList.remove('hidden');
    btn.classList.add('open');
    btn.innerHTML = '<span class="icon">✕</span> Закрыть';
    console.log('[UI] Панель добавления очков открыта');
  } else {
    panel.classList.add('hidden');
    btn.classList.remove('open');
    btn.innerHTML = '<span class="icon">＋</span> Добавить прогресс';
    console.log('[UI] Панель добавления очков закрыта');
  }
}

function submitPoints() {
  const pointsInput = document.getElementById('pointsInput');
  const subGoalSelect = document.getElementById('subGoalSelect');
  const descInput = document.getElementById('actionDescription');

  const points = parseInt(pointsInput.value);
  const subGoalId = subGoalSelect.value || null;
  const description = descInput.value.trim();

  if (!points || points <= 0) {
    showToast('Введите корректное количество очков', 'error');
    pointsInput.focus();
    return;
  }

  if (!description) {
    showToast('Введите описание действия', 'error');
    descInput.focus();
    return;
  }

  // Сохраняем данные для подтверждения
  pendingPointsData = { points, subGoalId, description };
  console.log(`[Points] Запрос подтверждения: ${points} очков, подзадача: ${subGoalId || 'нет'}, описание: "${description}"`);

  // Показываем модалку подтверждения
  showConfirmModal();
}

function confirmPoints() {
  if (!pendingPointsData) return;

  const { points, subGoalId, description } = pendingPointsData;

  // Добавляем в общий прогресс
  state.goalCurrent += points;
  console.log(`[Points] Добавлено ${points} очков в общий прогресс. Итого: ${state.goalCurrent}`);

  // Добавляем очки в подзадачу ТОЛЬКО если она была выбрана пользователем
  let subGoalTitle = '';
  if (subGoalId) {
    const sg = state.subGoals.find(s => s.id === subGoalId);
    if (sg) {
      sg.current = (sg.current || 0) + points;
      subGoalTitle = sg.title;
      console.log(`[Points] Добавлено ${points} очков подзадаче "${sg.title}". Итого: ${sg.current}`);
    }
  }

  // Создаём лог
  const logEntry = {
    id: generateId(),
    date: new Date().toISOString(),
    points,
    subGoalId,
    subGoalTitle,
    description
  };
  state.logs.push(logEntry);
  console.log(`[Logs] Создана запись: ${JSON.stringify(logEntry)}`);

  // Сохраняем и обновляем
  saveState();
  render();
  triggerProgressEffects(points);

  // Очищаем поля ввода
  document.getElementById('pointsInput').value = '';
  document.getElementById('actionDescription').value = '';
  document.getElementById('subGoalSelect').value = '';

  // Закрываем панель
  toggleAddPointsPanel();

  pendingPointsData = null;
  hideConfirmModal();
  showToast(`+${formatNumber(points)} ${state.goalUnit} добавлено!`);
}

// ============ PROGRESS EFFECTS & PARTICLES ============
function triggerProgressEffects(pointsAdded) {
  const fill = document.getElementById('progressFill');
  const percentEl = document.getElementById('progressPercent');
  const container = document.getElementById('particlesContainer');

  if (!fill || !container) return;

  // Анимация свечения и вспышки
  fill.classList.remove('updating');
  if (percentEl) percentEl.classList.remove('updating');
  void fill.offsetWidth; // сброс анимации
  fill.classList.add('updating');
  if (percentEl) percentEl.classList.add('updating');

  setTimeout(() => {
    fill.classList.remove('updating');
    if (percentEl) percentEl.classList.remove('updating');
  }, 700);

  // Вычисление позиции края прогресс-бара
  const wrapper = fill.parentElement;
  if (!wrapper) return;
  const wrapperRect = wrapper.getBoundingClientRect();
  const fillWidth = fill.offsetWidth;

  const color = state.goalColor || '#6366f1';
  const particleCount = Math.min(35, Math.max(15, pointsAdded * 2));

  for (let i = 0; i < particleCount; i++) {
    const p = document.createElement('div');
    p.className = 'particle';

    const size = Math.random() * 6 + 4; // 4px..10px
    p.style.width = size + 'px';
    p.style.height = size + 'px';

    // Координаты края полосы
    const startX = Math.max(12, Math.min(fillWidth, wrapperRect.width - 12));
    const startY = 14; // центр по высоте

    p.style.left = startX + 'px';
    p.style.top = startY + 'px';

    // Цвет в цвет прогресс-бара
    p.style.backgroundColor = color;
    p.style.color = color;

    // Вектор полёта партиклов
    const angle = (Math.random() - 0.5) * Math.PI * 1.6;
    const distance = Math.random() * 70 + 25;
    const dx = Math.cos(angle) * distance;
    const dy = (Math.random() - 0.75) * 60;

    p.style.setProperty('--dx', `${dx}px`);
    p.style.setProperty('--dy', `${dy}px`);
    p.style.animationDuration = `${0.6 + Math.random() * 0.5}s`;

    container.appendChild(p);

    setTimeout(() => p.remove(), 1100);
  }
}

// ============ CONFIRM MODAL ============
function showConfirmModal() {
  document.getElementById('confirmModal').classList.remove('hidden');
}

function hideConfirmModal() {
  document.getElementById('confirmModal').classList.add('hidden');
  pendingPointsData = null;
}

// ============ PASSWORD MODAL ============
function showPasswordModal(title, callback) {
  const modal = document.getElementById('passwordModal');
  const input = document.getElementById('passwordInput');
  const error = document.getElementById('passwordError');
  const titleEl = document.getElementById('passwordModalTitle');

  titleEl.textContent = title || 'Введите пароль';
  input.value = '';
  error.classList.add('hidden');
  modal.classList.remove('hidden');
  passwordCallback = callback;

  setTimeout(() => input.focus(), 100);
  console.log(`[Auth] Запрос пароля: "${title}"`);
}

function hidePasswordModal() {
  document.getElementById('passwordModal').classList.add('hidden');
  document.getElementById('passwordInput').value = '';
  document.getElementById('passwordError').classList.add('hidden');
  passwordCallback = null;
}

function submitPassword() {
  const input = document.getElementById('passwordInput');
  const error = document.getElementById('passwordError');
  const pwd = input.value;

  if (passwordCallback) {
    if (passwordCallback(pwd)) {
      console.log('[Auth] Пароль принят');
      hidePasswordModal();
    } else {
      error.classList.remove('hidden');
      input.value = '';
      input.focus();
      console.log('[Auth] Неверный пароль');
    }
  }
}

// ============ SETTINGS DRAWER ============
function openSettings() {
  showPasswordModal('Настройки — Введите пароль', (pwd) => {
    if (pwd === SETTINGS_PASSWORD) {
      renderSettingsContent();
      document.getElementById('settingsOverlay').classList.remove('hidden');
      console.log('[Settings] Панель настроек открыта');
      return true;
    }
    return false;
  });
}

function closeSettings() {
  document.getElementById('settingsOverlay').classList.add('hidden');
  console.log('[Settings] Панель настроек закрыта');
}

function renderSettingsContent() {
  const content = document.getElementById('settingsContent');
  const { githubToken, gistId } = state.cloudConfig || {};

  content.innerHTML = `
    <!-- Основная цель -->
    <div class="settings-group">
      <div class="settings-group-title">Основная цель</div>
      <div class="settings-field">
        <label for="settGoalTitle">Название цели</label>
        <input type="text" id="settGoalTitle" value="${escapeHtml(state.goalTitle)}" placeholder="Например: Набрать 1000 баллов">
      </div>
      <div class="form-row">
        <div class="settings-field">
          <label for="settGoalTarget">Цель (число)</label>
          <input type="number" id="settGoalTarget" value="${state.goalTarget}" min="${state.goalCurrent + 1}" placeholder="1000">
        </div>
        <div class="settings-field">
          <label for="settGoalUnit">Единица измерения</label>
          <input type="text" id="settGoalUnit" value="${escapeHtml(state.goalUnit)}" placeholder="очков">
        </div>
      </div>
      <div class="form-row">
        <div class="settings-field">
          <label for="settGoalColor">Цвет прогресс-бара</label>
          <input type="color" id="settGoalColor" value="${state.goalColor}">
        </div>
        <div class="settings-field">
          <label for="settGoalStart">Дата начала</label>
          <input type="text" id="settGoalStart" value="${state.goalStartDate}" placeholder="YYYY-MM-DD" 
            onfocus="this.type='date'" onblur="if(!this.value)this.type='text'">
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <!-- Облачная синхронизация GitHub -->
    <div class="settings-group">
      <div class="settings-group-title">☁️ Облачная синхронизация (GitHub Gist)</div>
      <p style="color: var(--text-muted); font-size: 0.8rem; margin-bottom: 12px; line-height: 1.4;">
        Безопасная синхронизация прогресса между устройствами. Все изменения также сохраняются локально для 100% оффлайн работы.
      </p>
      
      <div class="settings-field">
        <label for="settCloudToken">GitHub Personal Access Token (PAT)</label>
        <input type="password" id="settCloudToken" value="${escapeHtml(githubToken || '')}" placeholder="ghp_xxxxxxxxxxxxxx">
      </div>
      <div class="settings-field">
        <label for="settCloudGistId">Gist ID (создается автоматически)</label>
        <input type="text" id="settCloudGistId" value="${escapeHtml(gistId || '')}" placeholder="Автоматически после создания">
      </div>

      <div class="cloud-status-box" id="cloudStatusBox" style="margin-top: 10px; padding: 10px; border-radius: 8px; font-size: 0.82rem; background: rgba(255,255,255,0.05); border: 1px solid var(--border-subtle);">
      </div>

      <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
        <button class="btn-primary btn-sm" onclick="createCloudGist()" style="flex: 1; min-width: 140px;">✨ Создать облако</button>
        <button class="btn-secondary btn-sm" onclick="syncToCloud()" style="flex: 1; min-width: 140px;">🔄 Синхронизировать</button>
      </div>
    </div>

    <div class="divider"></div>

    <!-- Подзадачи -->
    <div class="settings-group">
      <div class="settings-group-title">Подзадачи</div>
      <div id="settingsSubGoalsList">
        ${renderSettingsSubGoalsList()}
      </div>
      <button class="btn-success btn-block" onclick="showAddSubGoalForm()" style="margin-top: 12px;">
        ＋ Добавить подзадачу
      </button>
      <div id="subGoalFormContainer"></div>
    </div>

    <div class="divider"></div>

    <!-- Сброс -->
    <div class="settings-group">
      <div class="settings-group-title">Опасная зона</div>
      <button class="btn-danger btn-block" onclick="resetProgress()">Сбросить весь прогресс</button>
    </div>
  `;

  renderCloudStatusBox();
}

function renderSettingsSubGoalsList() {
  if (state.subGoals.length === 0) {
    return '<p style="color: var(--text-muted); font-size: 0.85rem; text-align: center; padding: 12px;">Нет подзадач</p>';
  }

  return state.subGoals.map(sg => `
    <div class="settings-subgoal-item">
      <span class="color-dot" style="background: ${sg.color || '#6366f1'}"></span>
      <span class="settings-subgoal-name">${escapeHtml(sg.title)}</span>
      <div class="settings-subgoal-actions">
        <button class="icon-btn edit" onclick="editSubGoal('${sg.id}')" title="Редактировать">✏️</button>
        <button class="icon-btn delete" onclick="deleteSubGoal('${sg.id}')" title="Удалить">🗑️</button>
      </div>
    </div>
  `).join('');
}

function showAddSubGoalForm() {
  const container = document.getElementById('subGoalFormContainer');
  container.innerHTML = `
    <div class="subgoal-edit-form">
      <div class="form-title">Новая подзадача</div>
      <div class="settings-field">
        <label>Название</label>
        <input type="text" id="sgFormTitle" placeholder="Название подзадачи">
      </div>
      <div class="form-row">
        <div class="settings-field">
          <label>Цель (очки)</label>
          <input type="number" id="sgFormTarget" min="1" placeholder="например 100">
        </div>
        <div class="settings-field">
          <label>Цвет</label>
          <input type="color" id="sgFormColor" value="#6366f1">
        </div>
      </div>
      <div class="settings-field">
        <label>Описание</label>
        <textarea id="sgFormDesc" rows="3" placeholder="Описание подзадачи..."></textarea>
      </div>
      <div class="settings-field">
        <label>Награда за выполнение</label>
        <textarea id="sgFormReward" rows="2" placeholder="Например: Ссылка на игру или текст..."></textarea>
      </div>
      <div class="settings-field">
        <label>Картинка (необязательно)</label>
        <input type="file" id="sgFormImage" accept="image/*">
      </div>
      <div class="form-actions">
        <button class="btn-primary btn-sm" onclick="saveNewSubGoal()">Сохранить</button>
        <button class="btn-secondary btn-sm" onclick="cancelSubGoalForm()">Отмена</button>
      </div>
    </div>
  `;
}

function showEditSubGoalForm(sg) {
  const container = document.getElementById('subGoalFormContainer');
  container.innerHTML = `
    <div class="subgoal-edit-form">
      <div class="form-title">Редактирование: ${escapeHtml(sg.title)}</div>
      <div class="settings-field">
        <label>Название</label>
        <input type="text" id="sgFormTitle" value="${escapeHtml(sg.title)}">
      </div>
      <div class="form-row">
        <div class="settings-field">
          <label>Цель (очки)</label>
          <input type="number" id="sgFormTarget" min="1" value="${sg.target}">
        </div>
        <div class="settings-field">
          <label>Текущие очки подзадачи</label>
          <input type="number" id="sgFormCurrent" min="0" value="${sg.current || 0}">
        </div>
      </div>
      <div class="form-row">
        <div class="settings-field">
          <label>Цвет</label>
          <input type="color" id="sgFormColor" value="${sg.color || '#6366f1'}">
        </div>
        <div class="settings-field">
          <label>Дата создания</label>
          <input type="text" id="sgFormDate" value="${sg.createdAt || ''}" placeholder="YYYY-MM-DD"
            onfocus="this.type='date'" onblur="if(!this.value)this.type='text'">
        </div>
      </div>
      <div class="settings-field">
        <label>Описание</label>
        <textarea id="sgFormDesc" rows="3">${escapeHtml(sg.description || '')}</textarea>
      </div>
      <div class="settings-field">
        <label>Награда за выполнение</label>
        <textarea id="sgFormReward" rows="2">${escapeHtml(sg.reward || '')}</textarea>
      </div>
      <div class="settings-field">
        <label>Картинка ${sg.image ? '(текущая будет заменена)' : '(необязательно)'}</label>
        <input type="file" id="sgFormImage" accept="image/*">
        ${sg.image ? '<button class="btn-danger btn-sm" onclick="removeSubGoalImage(\'' + sg.id + '\')" style="margin-top:6px">Удалить картинку</button>' : ''}
      </div>
      <div class="form-actions">
        <button class="btn-primary btn-sm" onclick="saveEditSubGoal('${sg.id}')">Сохранить</button>
        <button class="btn-secondary btn-sm" onclick="cancelSubGoalForm()">Отмена</button>
      </div>
    </div>
  `;
}

function cancelSubGoalForm() {
  const container = document.getElementById('subGoalFormContainer');
  if (container) container.innerHTML = '';
}

function readImageFile(fileInput) {
  return new Promise((resolve) => {
    if (!fileInput.files || !fileInput.files[0]) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      // Стандартизация: ресайз картинки до макс 400x300
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxW = 400, maxH = 260;
        let w = img.width, h = img.height;
        const ratio = Math.min(maxW / w, maxH / h);
        if (ratio < 1) {
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        canvas.width = maxW;
        canvas.height = maxH;
        const ctx = canvas.getContext('2d');
        // Заполнение фоном
        ctx.fillStyle = '#16162a';
        ctx.fillRect(0, 0, maxW, maxH);
        // Центрирование картинки (cover эффект)
        const coverRatio = Math.max(maxW / img.width, maxH / img.height);
        const cw = img.width * coverRatio;
        const ch = img.height * coverRatio;
        ctx.drawImage(img, (maxW - cw) / 2, (maxH - ch) / 2, cw, ch);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
        console.log('[Image] Картинка стандартизирована: 400x260px');
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(fileInput.files[0]);
  });
}

async function saveNewSubGoal() {
  const title = document.getElementById('sgFormTitle').value.trim();
  const target = parseInt(document.getElementById('sgFormTarget').value);
  const color = document.getElementById('sgFormColor').value;
  const desc = document.getElementById('sgFormDesc').value.trim();
  const reward = document.getElementById('sgFormReward').value.trim();
  const fileInput = document.getElementById('sgFormImage');

  if (!title) {
    showToast('Введите название подзадачи', 'error');
    return;
  }
  if (!target || target <= 0) {
    showToast('Введите корректную цель подзадачи (число очков)', 'error');
    return;
  }

  const image = await readImageFile(fileInput);

  const newSG = {
    id: generateId(),
    title,
    target,
    startProgress: state.goalCurrent || 0,
    current: 0,
    color,
    description: desc,
    reward: reward,
    image,
    createdAt: new Date().toISOString().split('T')[0]
  };

  state.subGoals.push(newSG);
  saveState();

  console.log(`[SubGoal] Создана подзадача: "${title}", цель: ${target}`);
  showToast(`Подзадача "${title}" создана`);

  // Обновляем список в настройках
  document.getElementById('settingsSubGoalsList').innerHTML = renderSettingsSubGoalsList();
  cancelSubGoalForm();
  render();
}

function editSubGoal(id) {
  const sg = state.subGoals.find(s => s.id === id);
  if (!sg) return;
  showEditSubGoalForm(sg);
  console.log(`[SubGoal] Редактирование: "${sg.title}"`);
}

async function saveEditSubGoal(id) {
  const sg = state.subGoals.find(s => s.id === id);
  if (!sg) return;

  const title = document.getElementById('sgFormTitle').value.trim();
  const target = parseInt(document.getElementById('sgFormTarget').value);
  const current = parseInt(document.getElementById('sgFormCurrent').value) || 0;
  const color = document.getElementById('sgFormColor').value;
  const dateEl = document.getElementById('sgFormDate');
  const desc = document.getElementById('sgFormDesc').value.trim();
  const reward = document.getElementById('sgFormReward').value.trim();
  const fileInput = document.getElementById('sgFormImage');

  if (!title) {
    showToast('Введите название подзадачи', 'error');
    return;
  }
  if (!target || target <= 0) {
    showToast('Введите корректную цель подзадачи', 'error');
    return;
  }

  const newImage = await readImageFile(fileInput);

  sg.title = title;
  sg.target = target;
  sg.current = current;
  sg.color = color;
  sg.description = desc;
  sg.reward = reward;
  if (dateEl && dateEl.value) sg.createdAt = dateEl.value;
  if (newImage) sg.image = newImage;

  saveState();
  console.log(`[SubGoal] Обновлена подзадача: "${title}"`);
  showToast(`Подзадача "${title}" обновлена`);

  document.getElementById('settingsSubGoalsList').innerHTML = renderSettingsSubGoalsList();
  cancelSubGoalForm();
  render();
}

function removeSubGoalImage(id) {
  const sg = state.subGoals.find(s => s.id === id);
  if (sg) {
    sg.image = null;
    saveState();
    showEditSubGoalForm(sg);
    render();
    console.log(`[SubGoal] Картинка удалена для "${sg.title}"`);
  }
}

function deleteSubGoal(id) {
  const sg = state.subGoals.find(s => s.id === id);
  if (!sg) return;

  if (!confirm(`Удалить подзадачу "${sg.title}"? Это действие нельзя отменить.`)) return;

  state.subGoals = state.subGoals.filter(s => s.id !== id);
  saveState();

  console.log(`[SubGoal] Удалена подзадача: "${sg.title}"`);
  showToast(`Подзадача "${sg.title}" удалена`);

  document.getElementById('settingsSubGoalsList').innerHTML = renderSettingsSubGoalsList();
  cancelSubGoalForm();
  render();
}

function saveSettings() {
  const title = document.getElementById('settGoalTitle').value.trim();
  const target = parseInt(document.getElementById('settGoalTarget').value);
  const unit = document.getElementById('settGoalUnit').value.trim();
  const color = document.getElementById('settGoalColor').value;
  const startDate = document.getElementById('settGoalStart').value;
  const cloudToken = document.getElementById('settCloudToken')?.value.trim() || '';
  const cloudGistId = document.getElementById('settCloudGistId')?.value.trim() || '';

  if (!title) {
    showToast('Введите название цели', 'error');
    return;
  }
  if (!target || target <= state.goalCurrent) {
    showToast(`Цель должна быть строго больше текущего прогресса (сейчас: ${state.goalCurrent})`, 'error');
    return;
  }

  state.goalTitle = title;
  state.goalTarget = target;
  state.goalUnit = unit || 'очков';
  state.goalColor = color;

  if (!state.cloudConfig) state.cloudConfig = {};
  state.cloudConfig.githubToken = cloudToken;
  state.cloudConfig.gistId = cloudGistId;

  if (startDate) {
    state.goalStartDate = startDate;
  } else if (!state.goalStartDate) {
    state.goalStartDate = new Date().toISOString().split('T')[0];
  }

  saveState();
  render();
  closeSettings();

  console.log(`[Settings] Настройки сохранены: "${title}", цель: ${target} ${unit}`);
  showToast('Настройки сохранены!');
}

function resetProgress() {
  if (!confirm('Вы уверены? Весь прогресс будет сброшен!')) return;
  if (!confirm('Это действие НЕЛЬЗЯ отменить. Продолжить?')) return;

  state.goalCurrent = 0;
  state.logs = [];
  saveState();
  render();

  console.log('[Settings] Прогресс сброшен');
  showToast('Прогресс сброшен');
  renderSettingsContent();
}

// ============ LOGS MANAGEMENT DRAWER ============
function openLogsManagement() {
  showPasswordModal('Логи — Введите пароль', (pwd) => {
    if (pwd === LOGS_PASSWORD) {
      renderLogsManagement();
      document.getElementById('logsOverlay').classList.remove('hidden');
      console.log('[Logs] Панель управления логами открыта');
      return true;
    }
    return false;
  });
}

function closeLogsManagement() {
  document.getElementById('logsOverlay').classList.add('hidden');
  editingLogId = null;
  console.log('[Logs] Панель управления логами закрыта');
}

function renderLogsManagement(filterText = '') {
  const content = document.getElementById('logsContent');
  let filteredLogs = [...state.logs].reverse();

  if (filterText) {
    const lower = filterText.toLowerCase();
    filteredLogs = filteredLogs.filter(log =>
      (log.description && log.description.toLowerCase().includes(lower)) ||
      (log.subGoalTitle && log.subGoalTitle.toLowerCase().includes(lower)) ||
      formatDateTime(log.date).includes(lower)
    );
  }

  content.innerHTML = `
    <div class="logs-search">
      <input type="text" id="logsSearchInput" placeholder="Поиск по логам..." value="${escapeHtml(filterText)}" 
        oninput="renderLogsManagement(this.value)">
    </div>
    <p style="color: var(--text-muted); font-size: 0.82rem; margin-bottom: 12px;">
      Всего записей: ${state.logs.length}${filterText ? ` (найдено: ${filteredLogs.length})` : ''}
    </p>
    <div class="logs-management-list">
      ${filteredLogs.length === 0
        ? '<div class="logs-empty">Записей не найдено</div>'
        : filteredLogs.map(log => renderLogManageItem(log)).join('')
      }
    </div>
  `;
}

function renderLogManageItem(log) {
  const subGoal = log.subGoalId ? state.subGoals.find(sg => sg.id === log.subGoalId) : null;
  const isEditing = editingLogId === log.id;

  let html = `
    <div class="log-manage-item">
      <div class="log-manage-header">
        <div class="log-manage-meta">
          <span class="log-date">${formatDateTime(log.date)}</span>
          <span class="log-points">+${formatNumber(log.points)}</span>
          ${subGoal ? `<span class="log-subgoal-badge">${escapeHtml(subGoal.title)}</span>` :
            (log.subGoalTitle ? `<span class="log-subgoal-badge" style="opacity:0.5">${escapeHtml(log.subGoalTitle)}</span>` : '')}
        </div>
        <div class="log-manage-actions">
          <button class="icon-btn edit" onclick="startEditLog('${log.id}')" title="Редактировать">✏️</button>
          <button class="icon-btn delete" onclick="deleteLog('${log.id}')" title="Удалить">🗑️</button>
        </div>
      </div>
      <div class="log-manage-desc">${escapeHtml(log.description || '—')}</div>
  `;

  if (isEditing) {
    html += `
      <div class="log-edit-form">
        <div class="settings-field">
          <label>Очки</label>
          <input type="number" id="editLogPoints" value="${log.points}" min="1">
        </div>
        <div class="settings-field">
          <label>Описание</label>
          <textarea id="editLogDesc" rows="2">${escapeHtml(log.description || '')}</textarea>
        </div>
        <div class="settings-field">
          <label>Подзадача</label>
          <select id="editLogSubGoal">
            <option value="">Без подзадачи</option>
            ${state.subGoals.map(sg =>
              `<option value="${sg.id}" ${sg.id === log.subGoalId ? 'selected' : ''}>${escapeHtml(sg.title)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-actions">
          <button class="btn-primary btn-sm" onclick="saveEditLog('${log.id}')">Сохранить</button>
          <button class="btn-secondary btn-sm" onclick="cancelEditLog()">Отмена</button>
        </div>
      </div>
    `;
  }

  html += '</div>';
  return html;
}

function startEditLog(id) {
  editingLogId = id;
  renderLogsManagement(document.getElementById('logsSearchInput')?.value || '');
  console.log(`[Logs] Начато редактирование лога: ${id}`);
}

function cancelEditLog() {
  editingLogId = null;
  renderLogsManagement(document.getElementById('logsSearchInput')?.value || '');
}

function saveEditLog(id) {
  const log = state.logs.find(l => l.id === id);
  if (!log) return;

  const newPoints = parseInt(document.getElementById('editLogPoints').value);
  const newDesc = document.getElementById('editLogDesc').value.trim();
  const newSubGoalId = document.getElementById('editLogSubGoal').value || null;

  if (!newPoints || newPoints <= 0) {
    showToast('Введите корректное количество очков', 'error');
    return;
  }

  const pointsDiff = newPoints - log.points;

  // Обновляем главный прогресс
  state.goalCurrent += pointsDiff;
  console.log(`[Logs] Разница очков: ${pointsDiff}. Новый общий прогресс: ${state.goalCurrent}`);

  // Обновляем старую подзадачу (вычитаем очки старого лога)
  if (log.subGoalId) {
    const oldSG = state.subGoals.find(sg => sg.id === log.subGoalId);
    if (oldSG) {
      oldSG.current = Math.max(0, (oldSG.current || 0) - log.points);
    }
  }

  // Обновляем новую подзадачу (добавляем очки нового лога)
  if (newSubGoalId) {
    const newSG = state.subGoals.find(sg => sg.id === newSubGoalId);
    if (newSG) {
      newSG.current = (newSG.current || 0) + newPoints;
    }
  }
  log.points = newPoints;
  log.description = newDesc;
  log.subGoalId = newSubGoalId;
  log.subGoalTitle = newSubGoalId ? (state.subGoals.find(sg => sg.id === newSubGoalId)?.title || '') : '';

  editingLogId = null;
  saveState();
  render();
  renderLogsManagement(document.getElementById('logsSearchInput')?.value || '');

  console.log(`[Logs] Лог ${id} обновлён`);
  showToast('Запись обновлена');
}

function deleteLog(id) {
  const log = state.logs.find(l => l.id === id);
  if (!log) return;

  if (!confirm(`Удалить запись? Будет вычтено ${log.points} очков из прогресса.`)) return;

  // Вычитаем из общего прогресса
  state.goalCurrent -= log.points;
  state.goalCurrent = Math.max(0, state.goalCurrent);
  console.log(`[Logs] Удаление лога: вычтено ${log.points} из общего прогресса. Итого: ${state.goalCurrent}`);

  // Если лог был привязан к подзадаче, вычитаем из неё очки
  if (log.subGoalId) {
    const sg = state.subGoals.find(s => s.id === log.subGoalId);
    if (sg) {
      sg.current = Math.max(0, (sg.current || 0) - log.points);
    }
  }

  // Удаляем лог
  state.logs = state.logs.filter(l => l.id !== id);
  saveState();
  render();
  renderLogsManagement(document.getElementById('logsSearchInput')?.value || '');

  console.log(`[Logs] Лог ${id} удалён`);
  showToast('Запись удалена');
}

// ============ EVENT LISTENERS ============
function initEventListeners() {
  // Settings button
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  document.getElementById('settingsSaveBtn').addEventListener('click', saveSettings);

  // Settings overlay click to close
  document.getElementById('settingsOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('settingsOverlay')) closeSettings();
  });

  // Logs management button
  document.getElementById('logsManageBtn').addEventListener('click', openLogsManagement);
  document.getElementById('logsCloseBtn').addEventListener('click', closeLogsManagement);

  // Logs overlay click to close
  document.getElementById('logsOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('logsOverlay')) closeLogsManagement();
  });

  // Add points toggle
  document.getElementById('addPointsToggle').addEventListener('click', toggleAddPointsPanel);

  // Submit points
  document.getElementById('submitPointsBtn').addEventListener('click', submitPoints);

  // Confirm modal
  document.getElementById('confirmYesBtn').addEventListener('click', confirmPoints);
  document.getElementById('confirmNoBtn').addEventListener('click', hideConfirmModal);

  // Password modal
  document.getElementById('passwordSubmitBtn').addEventListener('click', submitPassword);
  document.getElementById('passwordCancelBtn').addEventListener('click', hidePasswordModal);

  // Password input enter key
  document.getElementById('passwordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPassword();
  });

  // Points input enter key
  document.getElementById('pointsInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPoints();
  });

  // Escape key closes modals/drawers
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!document.getElementById('passwordModal').classList.contains('hidden')) {
        hidePasswordModal();
      } else if (!document.getElementById('confirmModal').classList.contains('hidden')) {
        hideConfirmModal();
      } else if (!document.getElementById('settingsOverlay').classList.contains('hidden')) {
        closeSettings();
      } else if (!document.getElementById('logsOverlay').classList.contains('hidden')) {
        closeLogsManagement();
      }
    }
  });

  // Network online/offline event listeners
  window.addEventListener('online', () => {
    console.log('[Network] 🟢 Подключение к интернету восстановлено');
    showToast('Сеть восстановлена. Синхронизация...', 'success');
    if (state.cloudConfig && state.cloudConfig.githubToken && state.cloudConfig.gistId) {
      syncToCloud();
    }
  });

  window.addEventListener('offline', () => {
    console.log('[Network] 🔴 Интернет-соединение отсутствует. Включен оффлайн-режим.');
    showToast('Оффлайн-режим: Все данные сохраняются локально.', 'error');
    renderCloudStatusBox();
  });

  console.log('[Init] Обработчики событий инициализированы');
}

// ============ INITIALIZATION ============
function init() {
  console.log('[Init] =============================');
  console.log('[Init] Трекер Прогресса — запуск');
  console.log('[Init] =============================');

  loadState();
  initEventListeners();
  render();

  console.log('[Init] Приложение готово к работе');
}

// Запуск при загрузке DOM
document.addEventListener('DOMContentLoaded', init);

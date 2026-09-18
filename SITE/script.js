const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

let pendingCadreRoleKey = null;
let pendingOtpChallenge = null;
let backendState = {
    profile: null,
    competencies: null,
    assessments: null
};

const SESSION_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

function normalizeDepartmentId(value) {
    return value.trim();
}

function togglePassword(inputId, button) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    button.textContent = visible ? 'Show' : 'Hide';
    button.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
}

function showToast(message) {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function resetLoginOtpStep() {
    pendingOtpChallenge = null;
    const otpGroup = $('#login-otp-group');
    if (otpGroup) otpGroup.style.display = 'none';
    const otpInput = $('#officer-otp');
    if (otpInput) {
        otpInput.required = false;
        otpInput.value = '';
    }
    const submitBtn = $('#login-submit-button');
    if (submitBtn) submitBtn.innerHTML = '<span>Enter Command Portal</span> <span>&rarr;</span>';
}

function scheduleSessionExpiry(expiresAt) {
    clearTimeout(window._sessionExpiryTimer);
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
        handleLogout();
        return;
    }
    window._sessionExpiryTimer = setTimeout(() => handleLogout(), remaining);
}

function getNotifications() {
    const key = LocalStore.getStorageKey('notifications');
    const stored = JSON.parse(localStorage.getItem(key) || 'null');
    if (Array.isArray(stored)) return stored;
    const notifications = [
        { id: 'welcome', title: 'Welcome to your workspace', message: 'Your officer capability dashboard is ready.', unread: true },
        { id: 'baseline', title: 'Baseline recorded', message: 'Review your competency gaps and recommended practice modules.', unread: true }
    ];
    localStorage.setItem(key, JSON.stringify(notifications));
    return notifications;
}

function saveNotifications(notifications) {
    localStorage.setItem(LocalStore.getStorageKey('notifications'), JSON.stringify(notifications));
}

function addNotification(title, message) {
    const notifications = getNotifications();
    notifications.unshift({ id: `notification_${Date.now()}`, title, message, unread: true });
    saveNotifications(notifications.slice(0, 12));
    renderNotifications();
}

function renderNotifications() {
    const list = $('#notification-list');
    const dot = $('#notification-dot');
    if (!list || !dot) return;
    const notifications = getNotifications();
    const unread = notifications.some(item => item.unread);
    dot.hidden = !unread;
    list.innerHTML = '';
    if (!notifications.length) {
        list.innerHTML = '<div class="notification-empty">You are all caught up.</div>';
        return;
    }
    notifications.slice(0, 8).forEach(item => {
        const entry = document.createElement('article');
        entry.className = `notification-item${item.unread ? ' unread' : ''}`;
        entry.innerHTML = `<strong>${item.title}</strong><p>${item.message}</p>`;
        list.appendChild(entry);
    });
}

function toggleNotifications() {
    const panel = $('#notification-panel');
    const toggle = $('#notification-toggle');
    if (!panel || !toggle) return;
    const shouldOpen = panel.hidden;
    panel.hidden = !shouldOpen;
    toggle.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) {
        const notifications = getNotifications().map(item => ({ ...item, unread: false }));
        saveNotifications(notifications);
        renderNotifications();
    }
}

const API_CONFIG = {
    get baseUrl() {
        const saved = localStorage.getItem('aethernyx_api_base');
        if (saved && (!window.location.host || saved.includes(window.location.host))) return saved;
        return window.location.protocol === 'http:' || window.location.protocol === 'https:'
            ? `${window.location.origin}/api`
            : 'http://localhost:5000/api';
    },
    set baseUrl(url) {
        localStorage.setItem('aethernyx_api_base', url.replace(/\/+$/, ''));
    },
    get token() {
        return localStorage.getItem('aethernyx_token') || sessionStorage.getItem('aethernyx_token') || null;
    },
    set token(val) {
        if (val) {
            localStorage.setItem('aethernyx_token', val);
            sessionStorage.removeItem('aethernyx_token');
        } else {
            localStorage.removeItem('aethernyx_token');
            sessionStorage.removeItem('aethernyx_token');
        }
    },
    isConnected: false
};

const CADRES = {
    "data-analyst": {
        roleKey: "data-analyst",
        roleName: "Data Analyst (Official Statistics)",
        shortName: "Data Analyst",
        cadreTag: "Policy & Analytics",
        description: "MoSPI releases, survey quality, and evidence-led policy insights.",
        domains: [
            { domain: "Official Statistics & MoSPI", desc: "Statistical standards, official releases, and evidence-led administration", current: 62, target: 88 },
            { domain: "Macroeconomic Indicators", desc: "GDP, CPI, IIP, employment, and national indicator interpretation", current: 55, target: 85 },
            { domain: "Survey Methodology & Quality", desc: "Sampling, non-response, metadata, and survey quality assurance", current: 48, target: 82 },
            { domain: "Data Governance & Ethics", desc: "Confidentiality, anonymization, metadata, and responsible disclosure", current: 72, target: 86 },
            { domain: "Statistical Data Communication", desc: "Explaining estimates, revisions, uncertainty, and limitations", current: 58, target: 80 }
        ]
    },
    "director-ai": {
        roleKey: "director-ai",
        roleName: "Director of Statistical Systems",
        shortName: "Statistical Director",
        cadreTag: "MoSPI Leadership",
        description: "Official statistics stewardship, quality governance, and responsible AI support.",
        domains: [
            { domain: "Official Statistics & MoSPI", desc: "Stewardship of India's Official Statistical System and MoSPI programmes", current: 58, target: 92 },
            { domain: "Macroeconomic Indicators", desc: "National accounts, prices, labour, and industrial indicator interpretation", current: 62, target: 90 },
            { domain: "Statistical Quality Assurance", desc: "Survey design, revisions, comparability, and reproducibility", current: 55, target: 88 },
            { domain: "Responsible AI for Statistics", desc: "Auditable AI support without compromising official standards", current: 64, target: 90 }
        ]
    },
    "governance-officer": {
        roleKey: "governance-officer",
        roleName: "Official Statistics Programme Lead",
        shortName: "Programme Lead",
        cadreTag: "Statistical Operations",
        description: "Survey operations, indicator interpretation, and statistical data communication.",
        domains: [
            { domain: "Official Statistics & MoSPI", desc: "Using official releases for programme monitoring and policy decisions", current: 68, target: 88 },
            { domain: "Survey Operations", desc: "Field coordination, validation, non-response handling, and protocols", current: 52, target: 84 },
            { domain: "Macroeconomic Indicators", desc: "Reading indicator trends and communicating limitations", current: 60, target: 82 },
            { domain: "Data Governance & Ethics", desc: "Confidentiality, metadata completeness, and controlled access", current: 75, target: 88 }
        ]
    }
};

const REMEDIATION_CATALOG = {
    "Official Statistics & MoSPI": {
        title: "Working with MoSPI Official Releases",
        hours: "4.5 Hours",
        tag: "Priority Cadre",
        isCritical: true,
        desc: "Interpret metadata, release notes, revisions, and limitations before using official estimates."
    },
    "Survey Methodology & Quality": {
        title: "Survey Quality and Sampling Practice",
        hours: "3.0 Hours",
        tag: "Mandatory Audit",
        isCritical: true,
        desc: "Practice sampling, non-response, validation, and quality-assurance decisions in official surveys."
    },
    "Macroeconomic Indicators": {
        title: "Interpreting Macroeconomic Indicators",
        hours: "6.0 Hours",
        tag: "Core Upskill",
        isCritical: false,
        desc: "Build evidence-led decisions using national accounts, prices, labour, and industrial indicators."
    },
    "Statistical Data Communication": {
        title: "Communicating Estimates and Uncertainty",
        hours: "5.0 Hours",
        tag: "Executive Cadre",
        isCritical: true,
        desc: "Explain revisions, uncertainty, reference periods, and limitations to policy decision-makers."
    },
    "Data Governance & Ethics": {
        title: "Statistical Data Governance",
        hours: "4.0 Hours",
        tag: "Inclusion",
        isCritical: false,
        desc: "Maintain metadata completeness, controlled access, and responsible statistical data use."
    }
};

const ApiClient = {
    async request(endpoint, options = {}) {
        const url = `${API_CONFIG.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
        const { allowMockFallback = true, timeoutMs = 15000, ...requestOptions } = options;
        const isMultipart = typeof FormData !== 'undefined' && requestOptions.body instanceof FormData;
        const headers = {
            ...(isMultipart ? {} : { 'Content-Type': 'application/json' }),
            ...(requestOptions.headers || {})
        };
        if (API_CONFIG.token) {
            headers['Authorization'] = `Bearer ${API_CONFIG.token}`;
        }
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const response = await fetch(url, {
                ...requestOptions,
                headers,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            updateConnectionStatus(true);
            const data = await response.json();
            if (!response.ok) {
                const apiError = new Error(data.message || `Status ${response.status}`);
                apiError.isApiError = true;
                throw apiError;
            }
            return data;
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error('The service took too long to respond. Please try again.');
            }
            if (err.isApiError || !allowMockFallback) {
                if (err.isApiError) updateConnectionStatus(true);
                throw err;
            }
            updateConnectionStatus(false);
            return ApiClient.mockFallback(endpoint, options, err);
        }
    },
    async mockFallback(endpoint, options = {}) {
        const method = (options.method || 'GET').toUpperCase();
        if (endpoint === '/auth/login' && method === 'POST') {
            const body = JSON.parse(options.body || '{}');
            const departmentId = (body.departmentId || 'GOV-AI-2026').toUpperCase();
            const name = body.name || 'Rajesh Kumar';
            const token = `aethernyx_jwt_${btoa(departmentId + Date.now())}`;
            return { token, user: { name, departmentId, roleKey: 'data-analyst' } };
        }
        if (endpoint.startsWith('/user/profile') && method === 'GET') {
            return { profile: LocalStore.getProfile() };
        }
        if (endpoint === '/user/role' && method === 'PUT') {
            const body = JSON.parse(options.body || '{}');
            const profile = LocalStore.getProfile();
            profile.roleKey = body.roleKey;
            profile.roleName = CADRES[body.roleKey]?.roleName || body.roleKey;
            LocalStore.saveProfile(profile);
            return { profile };
        }
        if (endpoint.startsWith('/competencies') && method === 'GET') {
            const profile = LocalStore.getProfile();
            return { competencies: LocalStore.getCompetencies(profile.roleKey) };
        }
        if (endpoint.startsWith('/assessments') && method === 'GET') {
            return { assessments: LocalStore.getLogs() };
        }
        if (endpoint === '/assessments/submit' && method === 'POST') {
            const body = JSON.parse(options.body || '{}');
            return LocalStore.recordAssessment(body);
        }
        if (endpoint === '/quiz/generate' && method === 'POST') {
            const body = options.body instanceof FormData
                ? Object.fromEntries(options.body.entries())
                : JSON.parse(options.body || '{}');
            return LocalStore.synthesizeQuiz(body.topic, body.difficulty, body.count, body.roleKey);
        }
        if (endpoint === '/igot/status') return { configured: false, connected: false, provider: 'iGOT Karmayogi' };
        if (endpoint === '/igot/oauth/start') return { configured: false, connected: false };
        if (endpoint === '/igot/sync') return { success: true, provider: 'local demo', response: {} };
        return { success: true, message: 'Synchronized locally.' };
    }
};

async function updateIgotStatus() {
    const status = $('#igot-status');
    const connectButton = $('#igot-connect-btn');
    const syncButton = $('#igot-sync-btn');
    if (!status || !API_CONFIG.token) return;
    try {
        const result = await ApiClient.request('/igot/status');
        if (result.connected) {
            status.textContent = 'Connected to iGOT Karmayogi';
            status.className = 'integration-status connected';
            if (connectButton) connectButton.textContent = 'Connected';
            if (syncButton) syncButton.disabled = false;
        } else if (result.configured || result.mockMode) {
            status.textContent = 'Ready to connect';
            status.className = 'integration-status';
        } else {
            status.textContent = 'Integration credentials required';
            status.className = 'integration-status';
        }
    } catch (err) {
        status.textContent = 'Connection status unavailable';
    }
}

async function connectIgot() {
    try {
        const result = await ApiClient.request('/igot/oauth/start', { allowMockFallback: false, method: 'POST', body: JSON.stringify({}) });
        if (result.mock) {
            await updateIgotStatus();
            showToast('Connected to local iGOT simulation');
            return;
        }
        if (!result.configured) {
            showToast('Add iGOT OAuth settings to BACKEND/.env to connect.');
            return;
        }
        window.open(result.authorizationUrl, 'igot_oauth', 'width=620,height=720');
    } catch (err) {
        showToast(`iGOT connection error: ${err.message}`);
    }
}

async function syncIgotProgress() {
    try {
        await ApiClient.request('/igot/sync', {
            method: 'POST',
            allowMockFallback: false,
            body: JSON.stringify({ progress: backendState.assessments || LocalStore.getLogs() })
        });
        showToast('Progress synchronized with iGOT Karmayogi');
    } catch (err) {
        showToast(`iGOT sync error: ${err.message}`);
    }
}

function extractApiList(response, keys) {
    if (Array.isArray(response)) return response;
    for (const key of keys) {
        if (Array.isArray(response?.[key])) return response[key];
    }
    return null;
}

async function syncBackendState({ notify = false } = {}) {
    if (!API_CONFIG.token) return false;
    try {
        const profileResponse = await ApiClient.request('/user/profile', { allowMockFallback: false });
        const backendProfile = profileResponse?.profile || profileResponse?.user || profileResponse;
        const profile = backendProfile && typeof backendProfile === 'object' ? backendProfile : null;
        if (!profile) throw new Error('Backend returned an invalid profile.');
        backendState.profile = profile;

        const competenciesResponse = await ApiClient.request('/competencies', { allowMockFallback: false });
        const backendCompetencies = extractApiList(competenciesResponse, ['competencies', 'data']);
        if (!backendCompetencies) throw new Error('Backend returned invalid competency data.');
        backendState.competencies = backendCompetencies;

        const assessmentsResponse = await ApiClient.request('/assessments', { allowMockFallback: false });
        const backendAssessments = extractApiList(assessmentsResponse, ['assessments', 'logs', 'data']);
        if (!backendAssessments) throw new Error('Backend returned invalid assessment data.');
        backendState.assessments = backendAssessments;

        renderAllViews();
        updateIgotStatus();
        if (notify) showToast('Progress synchronized with backend');
        return true;
    } catch (err) {
        if (notify) showToast(`Backend sync unavailable: ${err.message}`);
        return false;
    }
}

const LocalStore = {
    getStorageKey(subKey) {
        const session = JSON.parse(localStorage.getItem('aethernyx_user') || sessionStorage.getItem('aethernyx_user') || '{}');
        const id = session.departmentId || 'DEFAULT';
        return `aethernyx_${subKey}_${id}`;
    },
    getProfile() {
        const session = JSON.parse(localStorage.getItem('aethernyx_user') || sessionStorage.getItem('aethernyx_user') || '{}');
        const key = this.getStorageKey('profile');
        let profile = JSON.parse(localStorage.getItem(key) || 'null');
        if (!profile) {
            profile = {
                departmentId: session.departmentId || 'GOV-AI-2026',
                name: session.name || 'Rajesh Kumar',
                roleKey: 'data-analyst',
                roleName: CADRES['data-analyst'].roleName,
                joinedDate: new Date(Date.now() - 25 * 86400000).toISOString().split('T')[0],
                lastActive: new Date().toISOString().split('T')[0]
            };
            localStorage.setItem(key, JSON.stringify(profile));
        }
        return profile;
    },
    saveProfile(profile) {
        const key = this.getStorageKey('profile');
        localStorage.setItem(key, JSON.stringify(profile));
    },
    getCompetencies(roleKey) {
        const key = this.getStorageKey(`comp_${roleKey}`);
        let stored = JSON.parse(localStorage.getItem(key) || 'null');
        if (!stored) {
            stored = JSON.parse(JSON.stringify(CADRES[roleKey]?.domains || CADRES['data-analyst'].domains));
            localStorage.setItem(key, JSON.stringify(stored));
        }
        return stored;
    },
    saveCompetencies(roleKey, list) {
        const key = this.getStorageKey(`comp_${roleKey}`);
        localStorage.setItem(key, JSON.stringify(list));
    },
    getLogs() {
        const key = this.getStorageKey('assessment_logs');
        let logs = JSON.parse(localStorage.getItem(key) || 'null');
        if (!logs) {
            logs = [];
            localStorage.setItem(key, JSON.stringify(logs));
        }
        return logs;
    },
    saveLogs(logs) {
        const key = this.getStorageKey('assessment_logs');
        localStorage.setItem(key, JSON.stringify(logs));
    },
    recordAssessment({ topic, domain, score }) {
        const profile = this.getProfile();
        const logs = this.getLogs();
        const today = new Date().toISOString().split('T')[0];
        const newLog = {
            id: 'eval_' + Date.now(),
            topic: topic.slice(0, 48),
            domain: domain || 'Official Statistics & MoSPI',
            date: today,
            score: Math.round(score),
            status: score >= 70 ? "Passed" : "Needs Review"
        };
        logs.unshift(newLog);
        this.saveLogs(logs);
        const compList = this.getCompetencies(profile.roleKey);
        let matched = compList.find(c => c.domain.toLowerCase() === (domain || '').toLowerCase());
        if (!matched) {
            matched = compList.find(c => topic.toLowerCase().includes(c.domain.toLowerCase().split(' ')[0])) || compList[0];
        }
        if (matched) {
            const updatedScore = Math.min(100, Math.max(20, round(matched.current * 0.7 + score * 0.3)));
            matched.current = updatedScore;
            this.saveCompetencies(profile.roleKey, compList);
        }
        profile.lastActive = today;
        this.saveProfile(profile);
        return { success: true, log: newLog, competencies: compList };
    },
    synthesizeQuiz(topic, difficulty, count = 3, roleKey = 'data-analyst') {
        const safeTopic = topic ? topic.trim() : "MoSPI Official Statistics";
        const roleDomains = CADRES[roleKey]?.domains || CADRES['data-analyst'].domains;
        const difficultyLabels = { easy: "Foundational", medium: "Operational", hard: "Strategic Decision" };
        const questionsPool = [
            {
                q: `When using an MoSPI release for "${safeTopic}", which practice best protects an official-statistics decision?`,
                options: [
                    "Reporting an estimate without its reference period or metadata",
                    "Checking release metadata, reference period, revisions, and stated limitations",
                    "Replacing the official estimate with an unverified social-media survey",
                    "Rounding all estimates to zero when uncertainty is not immediately visible"
                ],
                correct: 1,
                domain: "Official Statistics & MoSPI",
                rationale: "Official statistics must be interpreted with metadata, reference period, revisions, and limitations."
            },
            {
                q: `Why might a macroeconomic indicator for "${safeTopic}" change after its first release?`,
                options: [
                    "Because improved source data can be incorporated under the published revision policy",
                    "Because the first estimate is always intentionally false",
                    "Because earlier releases must be deleted",
                    "Because methodology never affects an official estimate"
                ],
                correct: 0,
                domain: "Macroeconomic Indicators",
                rationale: "Official estimates may be revised as more complete source data arrives under a published revision process."
            },
            {
                q: `For a survey connected to "${safeTopic}", which practice improves official-statistics quality?`,
                options: [
                    "Documenting the sample, non-response, validation rules, and limitations",
                    "Removing all metadata before publishing the result",
                    "Changing the sample after seeing the preferred outcome",
                    "Publishing an estimate without its reference period"
                ],
                correct: 0,
                domain: "Survey Methodology & Quality",
                rationale: "Transparent methodology, quality checks, metadata, and limitations make survey results interpretable and reproducible."
            }
        ];
        const selected = [];
        for (let i = 0; i < count; i++) {
            const template = questionsPool[i % questionsPool.length];
            selected.push({
                id: `q_${i + 1}`,
                question: template.q,
                options: template.options,
                correctIndex: template.correct,
                domain: roleDomains[i % roleDomains.length].domain,
                rationale: template.rationale
            });
        }
        return {
            topic: safeTopic,
            difficulty: difficulty || 'medium',
            difficultyLabel: difficultyLabels[difficulty] || "Operational",
            questions: selected
        };
    }
};

function computeUserMetrics() {
    const authenticated = Boolean(API_CONFIG.token && backendState.profile);
    const profile = authenticated ? backendState.profile : LocalStore.getProfile();
    const competencies = authenticated ? (backendState.competencies || []) : LocalStore.getCompetencies(profile.roleKey);
    const logs = authenticated ? (backendState.assessments || []) : LocalStore.getLogs();

    const hasLogs = logs.length > 0;
    const overallScore = hasLogs
        ? Math.round(competencies.reduce((sum, c) => sum + c.current, 0) / (competencies.length || 1))
        : 0;
    const targetAvg = competencies.length
        ? Math.round(competencies.reduce((sum, c) => sum + c.target, 0) / competencies.length)
        : 80;
    const alignmentPct = hasLogs && competencies.length
        ? Math.round(competencies.reduce((sum, c) => sum + Math.min(c.current / c.target, 1), 0) / competencies.length * 100)
        : 0;

    const uniqueDates = [...new Set(logs.map(item => item.date))].sort().reverse();
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    let streakDays = 0;
    if (uniqueDates.includes(today) || uniqueDates.includes(yesterday)) {
        streakDays = 1;
        let previousDate = new Date(uniqueDates[0]);
        for (let index = 1; index < uniqueDates.length; index += 1) {
            const currentDate = new Date(uniqueDates[index]);
            const difference = Math.round((previousDate - currentDate) / 86400000);
            if (difference !== 1) break;
            streakDays += 1;
            previousDate = currentDate;
        }
    }

    let streakRank = streakDays > 0 ? "Building Baseline Consistency" : "No Active Streak";
    if (streakDays >= 7) streakRank = "Top 5% in Administrative Cadre";
    else if (streakDays >= 4) streakRank = "Top 12% in Administrative Cohort";
    else if (streakDays >= 2) streakRank = "Top 25% in Cadre Progression";

    let auditStatus = "Pending Assessment";
    let auditSub = "Complete your first diagnostic test";
    let statusColor = "#eab308";
    if (hasLogs) {
        if (overallScore < 55) {
            auditStatus = "Needs Review";
            auditSub = "Critical Deficits in Statutory Modules";
            statusColor = "#f07f68";
        } else if (overallScore < 75) {
            auditStatus = "Provisional";
            auditSub = "Bridge Identified Gaps for Full Certification";
            statusColor = "#eab308";
        } else {
            auditStatus = "Certified";
            auditSub = "Meets MoSPI Statistical Baseline";
            statusColor = "#3b8878";
        }
    }

    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const activity = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(Date.now() - (6 - index) * 86400000);
        const dateValue = date.toISOString().split('T')[0];
        return {
            label: dayLabels[date.getDay()],
            value: logs.filter(item => item.date === dateValue).length
        };
    });

    const trend = hasLogs
        ? [...logs].reverse().slice(-7).map((item, index) => ({
            label: `Attempt ${index + 1}`,
            date: item.date,
            value: item.score
        }))
        : [{ label: 'No Data', value: 0 }];

    const sortedGaps = [...competencies].sort((a, b) => (a.current - a.target) - (b.current - b.target));
    const highestDeficit = sortedGaps[0] || null;
    const criticalCount = competencies.filter(item => item.current - item.target < -15).length;
    const remediationCount = competencies.filter(item => item.current < item.target).length;

    return {
        profile, competencies, logs, overallScore, targetAvg, alignmentPct,
        criticalCount, remediationCount, streakDays, streakRank,
        auditStatus, auditSub, statusColor, activity, trend, highestDeficit
    };
}

function renderAllViews() {
    const data = computeUserMetrics();
    const { profile, competencies, logs, overallScore, targetAvg, alignmentPct, criticalCount, streakDays, streakRank, auditStatus, auditSub, statusColor, highestDeficit } = data;
    const officerName = profile.name || 'Officer';
    const roleConfig = CADRES[profile.roleKey] || CADRES['data-analyst'];
    const initials = officerName.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase() || 'OF';
    const formatProfileDate = value => value
        ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
        : 'Not available';

    if ($('#topbar-officer-name')) $('#topbar-officer-name').innerText = officerName;
    if ($('#topbar-role-badge')) $('#topbar-role-badge').innerText = roleConfig.shortName;
    if ($('#officer-avatar')) $('#officer-avatar').innerText = initials;
    if ($('#profile-avatar')) $('#profile-avatar').innerText = initials;
    if ($('#profile-heading')) $('#profile-heading').innerText = `${officerName}'s Profile`;
    if ($('#profile-name')) $('#profile-name').innerText = officerName;
    if ($('#profile-role-summary')) $('#profile-role-summary').innerText = roleConfig.roleName;
    if ($('#profile-detail-name')) $('#profile-detail-name').innerText = officerName;
    if ($('#profile-detail-department')) $('#profile-detail-department').innerText = profile.departmentId || 'Not available';
    if ($('#profile-detail-cadre')) $('#profile-detail-cadre').innerText = roleConfig.roleName;
    if ($('#profile-detail-category')) $('#profile-detail-category').innerText = roleConfig.cadreTag;
    if ($('#profile-detail-joined')) $('#profile-detail-joined').innerText = formatProfileDate(profile.joinedDate);
    if ($('#profile-detail-active')) $('#profile-detail-active').innerText = formatProfileDate(profile.lastActive);
    if ($('#home-greeting-heading')) $('#home-greeting-heading').innerText = `Welcome, ${officerName}`;
    if ($('#dashboard-greeting')) $('#dashboard-greeting').innerText = `Officer ${officerName} Portfolio`;
    if ($('#sidebar-cadre-tag')) $('#sidebar-cadre-tag').innerText = roleConfig.cadreTag.toUpperCase();
    if ($('#sidebar-cadre-name')) $('#sidebar-cadre-name').innerText = roleConfig.roleName;

    if (highestDeficit && highestDeficit.current < highestDeficit.target) {
        const gapVal = highestDeficit.target - highestDeficit.current;
        if ($('#home-hero-title')) $('#home-hero-title').innerText = `Remediate ${highestDeficit.domain}`;
        if ($('#home-hero-desc')) $('#home-hero-desc').innerText = `Active deficit of ${gapVal}% against the ${highestDeficit.target}% statutory target. Complete targeted scenario evaluations to restore audit compliance.`;
        if ($('#home-hero-action-btn')) {
            $('#home-hero-action-btn').innerHTML = `Launch ${highestDeficit.domain.split(' ')[0]} Quiz <span>&rarr;</span>`;
            $('#home-hero-action-btn').onclick = () => {
                const topicInput = $('#topic-input');
                if (topicInput) topicInput.value = highestDeficit.domain;
                switchTab('mcq-generator');
            };
        }
    } else {
        if ($('#home-hero-title')) $('#home-hero-title').innerText = `Cadre Competencies Fully Aligned`;
        if ($('#home-hero-desc')) $('#home-hero-desc').innerText = `All core domains meet or exceed the ${targetAvg}% national statutory benchmark. Retain proficiency with continuous practice sets.`;
    }

    if ($('#home-card-score-badge')) $('#home-card-score-badge').innerText = `${overallScore}% SCORE`;
    const deficitDelta = Math.max(0, 100 - alignmentPct);
    if ($('#home-card-gap-badge')) $('#home-card-gap-badge').innerText = `  ${deficitDelta}% GAP`;
    if ($('#user-selected-role')) $('#user-selected-role').innerText = roleConfig.roleName;
    if ($('#user-role-subline')) $('#user-role-subline').innerText = `${roleConfig.cadreTag} Cadre`;
    if ($('#score-text')) $('#score-text').innerText = `${overallScore}%`;
    if ($('#competency-progress-bar')) $('#competency-progress-bar').style.width = `${overallScore}%`;
    if ($('#competency-score-status')) $('#competency-score-status').innerText = `${overallScore >= targetAvg ? 'Meets' : 'Below'} Cadre Baseline (${targetAvg}%)`;
    if ($('#streak-value')) $('#streak-value').innerHTML = `${streakDays} <small>days</small>`;
    if ($('#streak-rank')) $('#streak-rank').innerText = streakRank;
    if ($('#audit-status-badge')) {
        $('#audit-status-badge').innerText = auditStatus;
        $('#audit-status-badge').style.color = statusColor;
    }
    if ($('#audit-status-sub')) $('#audit-status-sub').innerText = auditSub;
    if ($('#overall-alignment-pct')) $('#overall-alignment-pct').innerText = `${alignmentPct}%`;
    if ($('#alignment-deficit')) $('#alignment-deficit').innerText = `  ${Math.max(0, 100 - alignmentPct)}% Deficit against civil benchmarks.`;
    if ($('#critical-gap-count')) $('#critical-gap-count').innerText = `${criticalCount} Priority ${criticalCount === 1 ? 'Area' : 'Areas'}`;

    const dial = $('#score-dial-element');
    if (dial) {
        const rot = Math.min(360, Math.round((alignmentPct / 100) * 360));
        dial.style.transform = `rotate(${rot}deg)`;
    }

    renderCompetencyMatrix(competencies);
    renderRemediationRoadmaps(competencies);
    renderAssessmentLogs(logs);
    renderConsistencyCharts(data.activity, data.trend);
    populateCadreDropdowns(profile.roleKey);
    renderNotifications();
}

function renderCompetencyMatrix(competencies) {
    const container = $('#gap-table-list');
    if (!container) return;
    container.innerHTML = '';
    competencies.forEach(item => {
        const gap = item.current - item.target;
        const row = document.createElement('div');
        row.className = 'competency-row';
        row.innerHTML = `
            <div class="competency-name">
                <strong>${item.domain}</strong>
                <span>${item.desc}</span>
            </div>
            <div>
                <div class="bar-wrap">
                    <div class="bar-current" style="width: ${Math.min(item.current, 100)}%;"></div>
                    <i class="bar-target" style="left: ${Math.min(item.target, 100)}%;" title="Target Standard: ${item.target}%"></i>
                </div>
                <div class="bar-values">
                    <span>Assessed: ${item.current}%</span>
                    <span>Target: ${item.target}%</span>
                </div>
            </div>
            <div class="gap-number ${gap < 0 ? 'alert' : ''}">
                ${gap >= 0 ? '+' + gap : gap}%
                <span>${gap < 0 ? 'Deficit' : 'Aligned'}</span>
            </div>
        `;
        container.appendChild(row);
    });
}

function renderRemediationRoadmaps(competencies) {
    const remContainer = $('#remediation-container');
    if (!remContainer) return;
    remContainer.innerHTML = '';
    const deficitItems = competencies.filter(c => c.current < c.target);
    if (deficitItems.length === 0) {
        remContainer.innerHTML = `
            <div class="panel" style="grid-column: 1 / -1; text-align: center; padding: 40px;">
                <div style="font-size: 32px; margin-bottom: 10px;"> </div>
                <h3>All Statutory Competencies Are Certified</h3>
                <p class="lede">No active deficits detected for this cadre. Explore advanced decision modules in the AI Quiz Lab.</p>
                <button class="button button-coral" style="margin-top: 14px;" onclick="switchTab('mcq-generator')">Explore Quiz Lab &rarr;</button>
            </div>
        `;
        return;
    }
    deficitItems.forEach(item => {
        const rem = REMEDIATION_CATALOG[item.domain] || {
            title: `${item.domain} Capability Bridging`,
            hours: "3.5 Hours",
            tag: "Core Focus",
            isCritical: (item.target - item.current) > 20,
            desc: item.desc
        };
        const card = document.createElement('article');
        card.className = 'catalog-card';
        card.innerHTML = `
            <div class="catalog-color ${rem.isCritical ? 'coral-bg' : 'teal-bg'}">
                <span>${rem.tag.toUpperCase()}</span>
                <span>${rem.hours}</span>
            </div>
            <div class="catalog-body">
                <h3>${rem.title}</h3>
                <p>${rem.desc}</p>
                <span class="catalog-meta">GAP: ${item.target - item.current}% DEFICIT &bull; SCENARIO LAB</span>
                <button class="catalog-action" onclick="launchRemediationFor('${item.domain}')">Launch Scenario Quiz &rarr;</button>
            </div>
        `;
        remContainer.appendChild(card);
    });
}

function launchRemediationFor(domain) {
    const topicInput = $('#topic-input');
    if (topicInput) topicInput.value = domain;
    switchTab('mcq-generator');
    showToast(`Prepared scenario generator for ${domain}`);
}

function renderAssessmentLogs(logs) {
    const tbody = $('#assessment-log-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!logs || logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 24px; color: var(--muted);">No assessment records logged yet. Complete a quiz in the lab to begin your audit trail.</td></tr>`;
        return;
    }
    logs.forEach(item => {
        const tr = document.createElement('tr');
        const isPass = item.score >= 70;
        tr.innerHTML = `
            <td><strong>${item.topic}</strong></td>
            <td style="color: var(--muted);">${item.domain || 'Civil Governance'}</td>
            <td>${item.date}</td>
            <td><strong>${item.score}%</strong></td>
            <td>
                <span class="log-status-pill ${isPass ? 'pill-pass' : 'pill-review'}">
                    ${item.status}
                </span>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function exportAuditLogCsv() {
    const logs = API_CONFIG.token && Array.isArray(backendState.assessments)
        ? backendState.assessments
        : LocalStore.getLogs();
    if (!logs.length) {
        showToast("No assessment logs to export");
        return;
    }
    const headers = ["Topic", "Domain", "Date Logged", "Score (%)", "Status"];
    const rows = logs.map(l => [
        `"${l.topic.replace(/"/g, '""')}"`,
        `"${l.domain.replace(/"/g, '""')}"`,
        l.date,
        l.score,
        l.status
    ]);
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Aethernyx_Audit_Log_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast("Audit log CSV exported");
}

function renderConsistencyCharts(activityData, trendData) {
    if (typeof Chart === 'undefined') return;
    const activityEl = document.getElementById('dailyActivityChart');
    const trendEl = document.getElementById('competencyTrendChart');
    if (!activityEl || !trendEl) return;

    const existingActivityChart = Chart.getChart(activityEl);
    const existingTrendChart = Chart.getChart(trendEl);
    if (existingActivityChart) existingActivityChart.destroy();
    if (existingTrendChart) existingTrendChart.destroy();

    const activityLabels = activityData.map(item => item.label);
    const activityValues = activityData.map(item => Number(item.value) || 0);
    const trendLabels = trendData.map(item => item.label);
    const trendValues = trendData.map(item => Number(item.value) || 0);

    new Chart(activityEl, {
        type: 'bar',
        data: {
            labels: activityLabels,
            datasets: [{
                label: 'Evaluations',
                data: activityValues,
                backgroundColor: '#3b8878',
                borderRadius: 6,
                barThickness: 18
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => `Assessments: ${ctx.parsed.y}` } }
            },
            scales: {
                y: { min: 0, max: 10, ticks: { stepSize: 2 } },
                x: { grid: { display: false } }
            }
        }
    });

    new Chart(trendEl, {
        type: 'line',
        data: {
            labels: trendLabels,
            datasets: [{
                label: 'Score',
                data: trendValues,
                borderColor: '#f07f68',
                backgroundColor: 'rgba(240, 127, 104, 0.14)',
                fill: true,
                tension: 0.35,
                pointRadius: 6,
                pointBackgroundColor: '#f07f68'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: items => {
                            const item = trendData[items[0].dataIndex];
                            return item?.date ? `${item.label} (${item.date})` : item?.label || '';
                        },
                        label: ctx => `Verified Score: ${ctx.parsed.y}%`
                    }
                }
            },
            scales: {
                y: { min: 0, max: 100, ticks: { callback: v => v + '%' } },
                x: { grid: { display: false } }
            }
        }
    });
}

let currentGeneratedQuiz = null;

async function handleGenerateQuiz() {
    const topic = $('#topic-input').value.trim();
    const learningFile = $('#learning-material')?.files?.[0];
    const count = parseInt($('#question-count')?.value || '3', 10);
    const difficulty = $('#difficulty')?.value || 'medium';
    const quizContainer = $('#quiz-container');
    const generateBtn = $('#generate-btn');

    if (!topic && !learningFile) {
        showToast("Enter a statistical topic or upload learning material first.");
        return;
    }
    if (isNaN(count) || count < 1 || count > 100) {
        showToast("Please specify between 1 and 100 questions.");
        return;
    }
    if (generateBtn) {
        generateBtn.disabled = true;
        generateBtn.innerHTML = `<span>Synthesizing Scenarios...</span>`;
    }
    quizContainer.innerHTML = `
        <div style="text-align: center; padding: 60px 20px;">
            <div class="empty-icon" style="animation: spin 1.2s infinite linear;"> </div>
            <h3>Generating Scenarios via AI Engine...</h3>
            <p class="lede">Synthesizing official-statistics challenges from "${(learningFile?.name || topic).slice(0, 35)}..."</p>
        </div>
    `;

    try {
        const formData = new FormData();
        formData.append('topic', topic);
        formData.append('difficulty', difficulty);
        formData.append('count', String(count));
        const activeProfile = backendState.profile || LocalStore.getProfile();
        formData.append('roleKey', activeProfile.roleKey || 'data-analyst');
        if (learningFile) formData.append('learning_material', learningFile);
        const response = await ApiClient.request('/quiz/generate', {
            method: 'POST',
            body: formData,
            // AI generation can take longer than ordinary API requests. The
            // default 15-second timeout was aborting valid Gemini responses.
            // Larger assessments have a proportionally longer AI response.
            timeoutMs: count > 25 ? 180000 : 45000
        });
        currentGeneratedQuiz = response;
        renderInteractiveQuiz(response);
        showToast("Practice set ready for evaluation");
    } catch (err) {
        showToast(`Generation error: ${err.message}`);
        quizContainer.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"> </div>
                <h2>Generation Failed</h2>
                <p>${err.message}</p>
            </div>
        `;
    } finally {
        if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.innerHTML = `<span>Generate Scenarios</span> <span>&rarr;</span>`;
        }
    }
}

function renderInteractiveQuiz(quizData) {
    const quizContainer = $('#quiz-container');
    if (!quizContainer) return;
    quizContainer.innerHTML = `
        <div class="panel-heading" style="margin-bottom: 20px;">
            <div>
                <span class="eyebrow accent">${quizData.difficultyLabel.toUpperCase()} LEVEL ASSESSMENT</span>
                <h2>Practice Set: ${quizData.topic.slice(0, 36)}${quizData.topic.length > 36 ? '...' : ''}</h2>
            </div>
            <span class="pill pill-teal">${quizData.questions.length} Questions</span>
        </div>
        <form id="interactive-quiz-form" onsubmit="handleQuizSubmission(event)">
            ${quizData.questions.map((item, idx) => `
                <div class="quiz-question" id="quiz-card-${idx}">
                    <p style="font-size: 13.5px; font-weight: 700; margin-bottom: 10px;">
                        ${idx + 1}. ${item.question}
                    </p>
                    <div style="display: grid; gap: 8px;">
                        ${item.options.map((opt, optIdx) => `
                            <label class="quiz-option" id="opt-label-${idx}-${optIdx}">
                                <input type="radio" name="q_${idx}" value="${optIdx}" required>
                                <span>${opt}</span>
                            </label>
                        `).join('')}
                    </div>
                    <div class="quiz-rationale" id="rationale-${idx}" style="display: none; margin-top: 10px;"></div>
                </div>
            `).join('')}
            <button type="submit" class="button button-coral full-button" id="submit-quiz-btn" style="margin-top: 20px;">
                <span>Submit Assessment to Audit Trail</span> <span>&rarr;</span>
            </button>
        </form>
    `;
}

async function handleQuizSubmission(e) {
    e.preventDefault();
    if (!currentGeneratedQuiz) return;
    const form = e.target;
    const submitBtn = $('#submit-quiz-btn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<span>Evaluating Responses...</span>`;
    }
    const total = currentGeneratedQuiz.questions.length;
    let correct = 0;
    currentGeneratedQuiz.questions.forEach((q, idx) => {
        const selected = form.querySelector(`input[name="q_${idx}"]:checked`);
        const userChoice = selected ? parseInt(selected.value, 10) : -1;
        const isRight = userChoice === q.correctIndex;
        if (isRight) correct++;
        const correctLabel = $(`#opt-label-${idx}-${q.correctIndex}`);
        if (correctLabel) correctLabel.classList.add('correct-choice');
        if (!isRight && userChoice >= 0) {
            const wrongLabel = $(`#opt-label-${idx}-${userChoice}`);
            if (wrongLabel) wrongLabel.classList.add('wrong-choice');
        }
        const rationaleDiv = $(`#rationale-${idx}`);
        if (rationaleDiv) {
            rationaleDiv.style.display = 'block';
            rationaleDiv.className = `quiz-rationale ${isRight ? 'pass' : 'fail'}`;
            rationaleDiv.innerHTML = `<strong>${isRight ? '  Valid Decision' : '  Flagged Decision'}:</strong> ${q.rationale}`;
        }
    });

    const scorePct = Math.round((correct / total) * 100);
    const domain = currentGeneratedQuiz.questions[0]?.domain || "Official Statistics & MoSPI";
    try {
        await ApiClient.request('/assessments/submit', {
            method: 'POST',
            body: JSON.stringify({
                topic: currentGeneratedQuiz.topic,
                domain: domain,
                score: scorePct
            })
        });
        await syncBackendState();
        renderAllViews();
        addNotification('Assessment completed', `Your ${scorePct}% practice score was added to the audit trail.`);

        const resultBanner = document.createElement('div');
        resultBanner.className = 'quiz-result';
        resultBanner.innerHTML = `
            <div style="font-size: 16px; margin-bottom: 4px;">
                Assessment Score: <strong>${scorePct}%</strong> (${correct}/${total} correct)
            </div>
            <div>
                ${scorePct >= 70 ? '  Meets National Statutory Baseline.' : '  Below 70% threshold - review flagged rationale above.'}
                Your score and competency profile have been updated dynamically across the platform.
            </div>
            <button type="button" class="button button-dark" style="margin-top: 14px;" onclick="switchTab('dashboard')">
                View Updated Dashboard &rarr;
            </button>
        `;
        form.appendChild(resultBanner);
        if (submitBtn) submitBtn.style.display = 'none';
        showToast(`Evaluation logged! Score: ${scorePct}%`);
    } catch (err) {
        showToast(`Submission error: ${err.message}`);
    }
}

function populateCadreDropdowns(activeRoleKey) {
    const dropdown = $('#target-role-dropdown');
    if (dropdown) {
        dropdown.innerHTML = Object.keys(CADRES).map(key => `
            <option value="${key}" ${key === activeRoleKey ? 'selected' : ''}>
                ${CADRES[key].roleName}
            </option>
        `).join('');
    }
    const modalList = $('#modal-role-buttons');
    if (modalList) {
        modalList.innerHTML = Object.keys(CADRES).map(key => `
            <button type="button" class="button ${key === activeRoleKey ? 'button-coral' : 'button-light'}" style="text-align: left; justify-content: space-between;" onclick="selectRole('${key}')">
                <span><strong>${CADRES[key].shortName}</strong> (${CADRES[key].cadreTag})</span>
                <span>${key === activeRoleKey ? '  Active' : 'Select &rarr;'}</span>
            </button>
        `).join('');
    }
}

async function handleRoleDropdownChange(newRoleKey) {
    await selectRole(newRoleKey);
}

async function selectRole(roleKey, confirmed = false) {
    if (!CADRES[roleKey]) return;
    const currentProfile = API_CONFIG.token && backendState.profile
        ? backendState.profile
        : LocalStore.getProfile();
    if (currentProfile.roleKey !== roleKey && !confirmed) {
        pendingCadreRoleKey = roleKey;
        const confirmModal = $('#cadre-confirm-overlay');
        if (confirmModal) confirmModal.style.display = 'flex';
        return;
    }
    try {
        await ApiClient.request('/user/role', {
            method: 'PUT',
            body: JSON.stringify({ roleKey })
        });
        const localProfile = LocalStore.getProfile();
        LocalStore.saveProfile({
            ...localProfile,
            roleKey,
            roleName: CADRES[roleKey].roleName
        });
        await syncBackendState();
        closeRoleModal();
        renderAllViews();
        addNotification('Cadre updated', `Your workspace is now calibrated for ${CADRES[roleKey].shortName}.`);
        showToast(`Operational cadre updated to: ${CADRES[roleKey].shortName}`);
    } catch (err) {
        showToast(`Error changing cadre: ${err.message}`);
    }
}

function closeCadreConfirm() {
    pendingCadreRoleKey = null;
    const confirmModal = $('#cadre-confirm-overlay');
    if (confirmModal) confirmModal.style.display = 'none';
    renderAllViews();
}

async function confirmCadreChange() {
    const roleKey = pendingCadreRoleKey;
    closeCadreConfirm();
    if (roleKey) await selectRole(roleKey, true);
}

function openRoleModal() {
    const modal = $('#role-modal-overlay');
    if (modal) modal.style.display = 'flex';
}

function closeRoleModal() {
    const modal = $('#role-modal-overlay');
    if (modal) modal.style.display = 'none';
}

function updateConnectionStatus(isConnected) {
    API_CONFIG.isConnected = isConnected;
    const dot = $('#backend-status-indicator');
    const text = $('#backend-status-text');
    if (dot) dot.className = `status-dot ${isConnected ? '' : 'offline'}`;
    if (text) text.innerText = isConnected ? 'System Ready' : 'Local Sync Mode';
}

async function handleLogin(e) {
    e.preventDefault();
    const name = $('#officer-name').value.trim();
    const departmentId = normalizeDepartmentId($('#officer-id').value);
    const email = $('#officer-email').value.trim().toLowerCase();
    const password = $('#officer-password').value;
    const otp = $('#officer-otp').value.trim();
    const errorMsg = $('#auth-error-msg');
    const submitBtn = $('#login-submit-button');

    if (errorMsg) errorMsg.style.display = 'none';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span>Verifying Credentials...</span>';
    }

    try {
        if (!pendingOtpChallenge) {
            const otpResponse = await ApiClient.request('/auth/request-otp', {
                method: 'POST',
                allowMockFallback: false,
                timeoutMs: 20000,
                body: JSON.stringify({ name, departmentId, email, password })
            });
            pendingOtpChallenge = otpResponse.challengeId;
            const otpGroup = $('#login-otp-group');
            if (otpGroup) otpGroup.style.display = 'block';
            const otpInput = $('#officer-otp');
            if (otpInput) otpInput.required = true;
            showToast(otpResponse.delivery === 'console' ? 'OTP generated. Check terminal.' : 'OTP sent to your registered email.');
            return;
        }

        if (!otp || !/^\d{6}$/.test(otp)) {
            throw new Error('Enter the 6-digit OTP sent to your registered email.');
        }

        const response = await ApiClient.request('/auth/verify-otp', {
            method: 'POST',
            allowMockFallback: false,
            body: JSON.stringify({ challengeId: pendingOtpChallenge, otp })
        });

        API_CONFIG.token = response.token;
        const expiresAt = Date.now() + SESSION_DURATION_MS;
        localStorage.setItem('aethernyx_user', JSON.stringify({
            name: name,
            departmentId: departmentId,
            roleKey: response.user?.roleKey || response.profile?.roleKey || 'data-analyst',
            expiresAt
        }));

        scheduleSessionExpiry(expiresAt);
        unlockApp();
        const synced = await syncBackendState();
        if (!synced) throw new Error('Unable to load your account data from the backend.');
        showToast(`Welcome back, Officer ${name}`);
        switchTab('home');
        pendingOtpChallenge = null;
    } catch (err) {
        if (errorMsg) {
            errorMsg.innerText = err.message || "Invalid authentication credentials.";
            errorMsg.style.display = 'block';
        }
        if (pendingOtpChallenge && /incorrect|expired|credentials/i.test(err.message || '')) {
            resetLoginOtpStep();
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = pendingOtpChallenge
                ? '<span>Verify OTP</span> <span>&rarr;</span>'
                : '<span>Enter Command Portal</span> <span>&rarr;</span>';
        }
    }
}

function showRegisterView() {
    $('#login-view').style.display = 'none';
    $('#register-view').style.display = 'flex';
    $('#forgot-password-view').style.display = 'none';
    $('#register-form')?.reset();
    const errorMsg = $('#register-error-msg');
    if (errorMsg) errorMsg.style.display = 'none';
}

function showLoginView() {
    $('#register-view').style.display = 'none';
    $('#forgot-password-view').style.display = 'none';
    $('#login-view').style.display = 'flex';
    $('#login-form')?.reset();
    resetLoginOtpStep();
    window.pendingRecoveryChallenge = null;
    const errorMsg = $('#auth-error-msg');
    if (errorMsg) errorMsg.style.display = 'none';
}

function showForgotPasswordView() {
    $('#login-view').style.display = 'none';
    $('#register-view').style.display = 'none';
    $('#forgot-password-view').style.display = 'flex';
    $('#forgot-password-form')?.reset();
    window.pendingRecoveryChallenge = null;
    ['recovery-otp-group', 'recovery-password-group', 'recovery-confirm-password-group'].forEach(id => {
        const group = $(`#${id}`);
        if (group) group.style.display = 'none';
    });
    const errorMsg = $('#recovery-error-msg');
    if (errorMsg) errorMsg.style.display = 'none';
}

function handleRegister(e) {
    e.preventDefault();
    const name = $('#register-name').value.trim();
    const departmentId = normalizeDepartmentId($('#register-id').value);
    const email = $('#register-email').value.trim().toLowerCase();
    const password = $('#register-password').value;
    const confirmPassword = $('#register-confirm-password').value;
    const errorMsg = $('#register-error-msg');

    if (password !== confirmPassword) {
        errorMsg.innerText = 'Passwords do not match.';
        errorMsg.style.display = 'block';
        return;
    }

    (async () => {
        try {
            await ApiClient.request('/auth/register', {
                method: 'POST',
                allowMockFallback: false,
                body: JSON.stringify({ name, departmentId, email, password })
            });
            showLoginView();
            showToast('Registration complete. Please login.');
        } catch (err) {
            errorMsg.innerText = err.message || 'Unable to create the officer account.';
            errorMsg.style.display = 'block';
        }
    })();
}

function handlePasswordReset(e) {
    e.preventDefault();
    const name = $('#recovery-name').value.trim();
    const email = $('#recovery-email').value.trim().toLowerCase();
    const otp = $('#recovery-otp').value.trim();
    const password = $('#recovery-password').value;
    const confirmPassword = $('#recovery-confirm-password').value;
    const errorMsg = $('#recovery-error-msg');

    if (!window.pendingRecoveryChallenge) {
        (async () => {
            try {
                const response = await ApiClient.request('/auth/request-password-reset-otp', {
                    method: 'POST',
                    allowMockFallback: false,
                    timeoutMs: 20000,
                    body: JSON.stringify({ name, email })
                });
                window.pendingRecoveryChallenge = response.challengeId;
                $('#recovery-otp-group').style.display = 'block';
                $('#recovery-password-group').style.display = 'block';
                $('#recovery-confirm-password-group').style.display = 'block';
                $('#recovery-otp').required = true;
                $('#recovery-password').required = true;
                $('#recovery-confirm-password').required = true;
                $('#recovery-submit-button').innerHTML = 'Verify OTP & Reset Password <span>&rarr;</span>';
                showToast(response.delivery === 'console' ? 'OTP generated. Check terminal.' : 'Password reset OTP sent to your email.');
            } catch (err) {
                errorMsg.innerText = err.message || 'Unable to send the password reset OTP.';
                errorMsg.style.display = 'block';
            }
        })();
        return;
    }

    if (!otp || !/^\d{6}$/.test(otp)) {
        errorMsg.innerText = 'Enter the 6-digit OTP sent to your email.';
        errorMsg.style.display = 'block';
        return;
    }

    if (password !== confirmPassword) {
        errorMsg.innerText = 'Passwords do not match.';
        errorMsg.style.display = 'block';
        return;
    }

    (async () => {
        try {
            await ApiClient.request('/auth/verify-password-reset-otp', {
                method: 'POST',
                allowMockFallback: false,
                body: JSON.stringify({ challengeId: window.pendingRecoveryChallenge, otp, password })
            });
            window.pendingRecoveryChallenge = null;
            showLoginView();
            showToast('Password reset successfully. Please login.');
        } catch (err) {
            errorMsg.innerText = err.message || 'Unable to reset the officer password.';
            errorMsg.style.display = 'block';
        }
    })();
}

function unlockApp() {
    $('#login-view').style.display = 'none';
    $('#app-shell').style.display = 'flex';
}

function handleLogout() {
    clearTimeout(window._sessionExpiryTimer);
    API_CONFIG.token = null;
    backendState = { profile: null, competencies: null, assessments: null };
    resetLoginOtpStep();
    localStorage.removeItem('aethernyx_user');
    sessionStorage.removeItem('aethernyx_user');

    const form = $('#login-form');
    if (form) form.reset();
    const errorMsg = $('#auth-error-msg');
    if (errorMsg) errorMsg.style.display = 'none';

    $('#app-shell').style.display = 'none';
    $('#register-view').style.display = 'none';
    $('#forgot-password-view').style.display = 'none';
    $('#login-view').style.display = 'flex';
    showToast('Officer session concluded');
}

function checkAuthSession() {
    const user = JSON.parse(localStorage.getItem('aethernyx_user') || sessionStorage.getItem('aethernyx_user') || 'null');
    const expiresAt = Number(user?.expiresAt);
    if (API_CONFIG.token && user && expiresAt > Date.now()) {
        scheduleSessionExpiry(expiresAt);
        unlockApp();
        syncBackendState().then(synced => {
            if (!synced) handleLogout();
        });
        return;
    }
    handleLogout();
}

function switchTab(tabId) {
    $$('.tab-content').forEach(tab => tab.classList.remove('active'));
    const target = document.getElementById(tabId);
    if (target) target.classList.add('active');

    $$('#main-nav .nav-item').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.tab === tabId) btn.classList.add('active');
    });

    const labels = {
        'home': 'Overview',
        'profile': 'Officer Profile',
        'dashboard': 'Competency Dashboard',
        'gap-analysis': 'Gap Diagnostics',
        'mcq-generator': 'AI Quiz Lab'
    };
    const viewLabel = $('#current-view-label');
    if (viewLabel) viewLabel.textContent = labels[tabId] || 'Workspace';
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (tabId === 'home') {
        const brandLetters = document.querySelectorAll('.brand-letter');
        brandLetters.forEach(brandLetter => {
            brandLetter.classList.remove('home-visit');
            void brandLetter.offsetWidth;
            brandLetter.classList.add('home-visit');
        });
    }

    if (tabId === 'dashboard') {
        setTimeout(() => {
            const data = computeUserMetrics();
            renderConsistencyCharts(data.activity, data.trend);
        }, 80);
    }
}

function applyTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('dark-mode', isDark);
    const toggle = $('#theme-toggle');
    if (toggle) {
        toggle.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
        toggle.setAttribute('aria-label', toggle.title);
        toggle.innerHTML = `<span aria-hidden="true">${isDark ? ' ' : ' '}</span><span>${isDark ? 'Light mode' : 'Dark mode'}</span>`;
    }
}

function applyFocusMode(isFocused) {
    document.body.classList.toggle('focus-mode', isFocused);
    const toggle = $('#focus-toggle');
    if (toggle) {
        toggle.title = isFocused ? 'Exit focus mode' : 'Enter focus mode';
        toggle.setAttribute('aria-label', toggle.title);
        toggle.innerHTML = `<span aria-hidden="true">${isFocused ? ' ' : ' '}</span><span>${isFocused ? 'Exit focus' : 'Focus mode'}</span>`;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    checkAuthSession();
    if (document.getElementById('app-shell')?.style.display === 'flex') {
        switchTab('home');
    }
    const savedTheme = localStorage.getItem('aethernyx_theme') || 'light';
    applyTheme(savedTheme);

    const themeToggle = $('#theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const nextTheme = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
            localStorage.setItem('aethernyx_theme', nextTheme);
            applyTheme(nextTheme);
        });
    }

    const focusToggle = $('#focus-toggle');
    applyFocusMode(localStorage.getItem('aethernyx_focus_mode') === 'true');
    if (focusToggle) {
        focusToggle.addEventListener('click', () => {
            const nextFocusMode = !document.body.classList.contains('focus-mode');
            localStorage.setItem('aethernyx_focus_mode', String(nextFocusMode));
            applyFocusMode(nextFocusMode);
        });
    }

    const notificationToggle = $('#notification-toggle');
    const notificationClear = $('#notification-clear');
    if (notificationToggle) notificationToggle.addEventListener('click', toggleNotifications);
    if (notificationClear) {
        notificationClear.addEventListener('click', () => {
            saveNotifications(getNotifications().map(item => ({ ...item, unread: false })));
            renderNotifications();
        });
    }

    const learningMaterial = $('#learning-material');
    if (learningMaterial) {
        learningMaterial.addEventListener('change', () => {
            const fileName = $('#learning-material-name');
            if (fileName) fileName.textContent = learningMaterial.files[0]?.name || 'No file selected';
        });
    }
    window.addEventListener('message', event => {
        if (event.origin === window.location.origin && event.data?.type === 'igot-connected') {
            showToast('iGOT Karmayogi connected');
            updateIgotStatus();
        }
    });

    document.addEventListener('click', event => {
        const wrap = document.querySelector('.notification-wrap');
        const panel = $('#notification-panel');
        const toggle = $('#notification-toggle');
        if (wrap && panel && toggle && !wrap.contains(event.target)) {
            panel.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
        }
    });

    window.addEventListener('click', e => {
        if (e.target.classList.contains('modal-overlay')) {
            e.target.style.display = 'none';
        }
    });
});

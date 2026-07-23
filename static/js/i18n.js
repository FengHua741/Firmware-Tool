// ==================== 国际化 (i18n) 框架 ====================
const I18n = {
    _lang: 'zh-CN',
    _strings: {},
    _fallback: {},

    async init() {
        this._lang = localStorage.getItem('firmwareToolLang') || navigator.language || 'zh-CN';
        if (!['zh-CN', 'en'].includes(this._lang)) this._lang = 'zh-CN';
        await this._load(this._lang);
        if (this._lang !== 'zh-CN') {
            try {
                const resp = await fetch('/static/i18n/zh-CN.json');
                this._fallback = await resp.json();
            } catch (e) {}
        }
        this.applyToDOM();
        const sel = document.getElementById('langSelect');
        if (sel) sel.value = this._lang;
    },

    async _load(lang) {
        if (!['zh-CN', 'en'].includes(lang)) lang = 'zh-CN';
        try {
            const resp = await fetch(`/static/i18n/${lang}.json`);
            this._strings = await resp.json();
        } catch (e) {
            this._strings = {};
        }
    },

    t(key, params) {
        let str = this._strings[key] || this._fallback[key] || key;
        if (params) {
            Object.entries(params).forEach(([k, v]) => {
                str = str.replace(`{${k}}`, v);
            });
        }
        return str;
    },

    applyToDOM() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (key) el.textContent = this.t(key);
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            if (key) el.placeholder = this.t(key);
        });
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            if (key) el.title = this.t(key);
        });
    },

    setLang(lang) {
        localStorage.setItem('firmwareToolLang', lang);
        location.reload();
    }
};

function t(key, params) { return I18n.t(key, params); }

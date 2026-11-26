// =====================================================================
// i18n.js — 各デモページ共通の言語切り替え (ja / ko / en)
//
// 使い方:
//   1. ページ側で PAGE_STRINGS = { ja: {...}, ko: {...}, en: {...} } を定義し
//      I18N.init(PAGE_STRINGS) を呼ぶ
//   2. 静的要素は data-i18n="キー" を付ける (innerHTMLで流し込むので<br>可)
//   3. 実行時の文字列は I18N.t('キー')。
//      日本語原文しか手元にない文字列 (共有ライブラリからのステータス等) は
//      I18N.tr(原文) — ja辞書の値と一致するキーを逆引きして変換する
//   4. '_title' キーがあれば document.title にも反映する
//
// 言語の決定: ?lang= → localStorage ('lang') → ブラウザ言語 → en。
// 一覧ページ (index.html) と同じ localStorage キーを使うため、
// 一覧で選んだ言語が各デモにも引き継がれる。
// =====================================================================
window.I18N = (function () {
    const supported = ['ja', 'ko', 'en'];
    const names = { ja: '日本語', ko: '한국어', en: 'English' };
    let dict = {};
    let lang = 'en';
    const listeners = [];

    function detect() {
        const param = new URLSearchParams(location.search).get('lang');
        let saved = null;
        try { saved = localStorage.getItem('lang'); } catch (e) { /* private mode */ }
        const browser = (navigator.language || 'en').slice(0, 2);
        return [param, saved, browser].find(l => supported.includes(l)) || 'en';
    }

    function t(key) {
        return (dict[lang] && dict[lang][key])
            ?? (dict.ja && dict.ja[key])
            ?? key;
    }

    function tr(text) {
        if (lang === 'ja' || !dict.ja) return text;
        for (const k in dict.ja) {
            if (dict.ja[k] === text) return t(k);
        }
        return text;
    }

    function apply() {
        document.documentElement.lang = lang;
        document.querySelectorAll('[data-i18n]').forEach(el => {
            el.innerHTML = t(el.dataset.i18n);
        });
        if (dict.ja && dict.ja._title) document.title = t('_title');
        document.querySelectorAll('[data-set-lang]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.setLang === lang);
        });
        try { localStorage.setItem('lang', lang); } catch (e) { /* private mode */ }
        listeners.forEach(fn => fn(lang));
    }

    function set(l) {
        if (!supported.includes(l)) return;
        lang = l;
        apply();
    }

    function init(d) {
        dict = d;
        lang = detect();

        // 切り替えボタン (#lang-nav がページにあれば生成)
        const nav = document.getElementById('lang-nav');
        if (nav) {
            supported.forEach(l => {
                const b = document.createElement('button');
                b.type = 'button';
                b.dataset.setLang = l;
                b.textContent = names[l];
                b.addEventListener('click', e => {
                    e.stopPropagation();
                    set(l);
                });
                nav.appendChild(b);
            });
        }

        // 共通スタイル (ページごとのCSS重複を避ける)
        const style = document.createElement('style');
        style.textContent = `
            #lang-nav { display: flex; gap: 8px; justify-content: center; margin-bottom: 20px; }
            #lang-nav button {
                padding: 5px 16px; font-size: 13px; color: #aaa;
                background: transparent; border: 1px solid #555; border-radius: 6px;
            }
            #lang-nav button.active { color: #14141e; background: #e8e8e8; border-color: #e8e8e8; }
        `;
        document.head.appendChild(style);

        apply();
    }

    return {
        init, set, t, tr,
        get lang() { return lang; },
        onChange(fn) { listeners.push(fn); },
    };
})();

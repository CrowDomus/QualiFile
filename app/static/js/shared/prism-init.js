const PRISM_VERSION = '1.29.0';
const OFFLINE_ASSETS = window.__QUALIFILE__?.offlineAssets === true;
const LOCAL_COMPONENTS_PATH = '/static/dist/vendor/prism/components/';

(function initPrism() {
  const configure = () => {
    const prism = window.Prism;
    if (!prism) {
      return;
    }
    prism.manual = true;
    const autoloader = prism.plugins?.autoloader;
    if (autoloader) {
      autoloader.languages_path = OFFLINE_ASSETS
        ? LOCAL_COMPONENTS_PATH
        : `https://cdn.jsdelivr.net/npm/prismjs@${PRISM_VERSION}/components/`;
      autoloader.use_minified = true;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', configure, { once: true });
  }
  configure();
})();

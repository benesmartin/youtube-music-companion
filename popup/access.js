// Site access, asked from a tab: Firefox anchors the permission prompt
// under an open extension popup, where it can't be seen or answered.

const ext = globalThis.browser ?? globalThis.chrome;
const YTM_TABS = "https://music.youtube.com/*";
// Lyrics come from LRCLIB; one prompt covers both.
const SITE_ACCESS = { origins: [YTM_TABS, "https://lrclib.net/*"] };

const el = (id) => document.getElementById(id);

// Same lookup as the popup: its cached language override first.
let overrideCatalog = null;
try {
  overrideCatalog = JSON.parse(localStorage.getItem("i18n"));
} catch {
  // the browser's catalog it is
}
const t = (key) =>
  overrideCatalog?.messages?.[key]?.message || ext.i18n.getMessage(key) || key;

document.documentElement.lang = String(overrideCatalog?.lang ?? t("locale")).replace(/_/g, "-");
for (const node of document.querySelectorAll("[data-i18n]")) {
  node.textContent = t(node.dataset.i18n);
}

Promise.resolve(ext.storage.local.get("settings")).then(({ settings } = {}) => {
  const theme = settings?.theme ?? "dark";
  const light =
    theme === "light" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  document.body.classList.toggle("light", light);
});

// A YTM tab opened before access was granted has no content script until it
// reloads, so the last step offers that reload rather than doing it unasked -
// the tab may be playing.
async function showGranted() {
  el("allow").hidden = true;
  el("title").textContent = t("accessGrantedTitle");
  const tabs = await ext.tabs.query({ url: YTM_TABS });
  el("sub").textContent = t(tabs.length ? "accessGrantedReloadSub" : "accessGrantedOpenSub");
  el("next").textContent = t(tabs.length ? "accessReloadTab" : "emptyOpenYtm");
  el("next").hidden = false;
  el("next").onclick = async () => {
    if (tabs.length) {
      for (const tab of tabs) await ext.tabs.reload(tab.id);
      await ext.tabs.update(tabs[0].id, { active: true });
    } else {
      await ext.tabs.create({ url: "https://music.youtube.com/" });
    }
    const self = await ext.tabs.getCurrent();
    if (self) ext.tabs.remove(self.id);
  };
}

// request() needs the click's user gesture, so nothing may be awaited first.
el("allow").addEventListener("click", () => {
  Promise.resolve(ext.permissions.request(SITE_ACCESS)).then(
    (granted) => granted && showGranted(),
    () => {}
  );
});

// Granted meanwhile (the browser's own extensions menu): skip to the end.
Promise.resolve(ext.permissions.contains({ origins: [YTM_TABS] })).then(
  (granted) => granted && showGranted(),
  () => {}
);

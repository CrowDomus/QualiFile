(() => {
  const storageKey = "qualifile_tutorial_theme";
  const root = document.documentElement;
  const themeToggle = document.getElementById("theme-toggle");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const searchInput = document.getElementById("search-input");
  const searchButton = document.getElementById("search-button");
  const searchResults = document.getElementById("search-results");
  const searchPopover = document.getElementById("search-popover");
  const searchCount = document.getElementById("search-count");
  const tocContainer = document.getElementById("toc");
  const clearButton = document.getElementById("search-clear");
  const contentRoot = document.getElementById("tutorial");
  const topbar = document.querySelector(".topbar");

  const setTheme = (value) => {
    const next = value === "dark" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    localStorage.setItem(storageKey, next);
    if (themeToggle) {
      themeToggle.textContent = next === "dark" ? "Light mode" : "Dark mode";
      themeToggle.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
    }
  };

  const initTheme = () => {
    const stored = localStorage.getItem(storageKey);
    setTheme(stored || "light");
  };

  const setTopbarHeight = () => {
    if (!topbar) return;
    const height = topbar.offsetHeight || 64;
    root.style.setProperty("--topbar-height", `${height}px`);
  };

  const slugify = (text) =>
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\\s-]/g, "")
      .replace(/\\s+/g, "-")
      .replace(/-+/g, "-");

  const addAnchorLinks = () => {
    if (!contentRoot) return;
    const headings = contentRoot.querySelectorAll("h2, h3, h4");
    const used = new Set();
    headings.forEach((heading) => {
      if (!heading.id) {
        const base = slugify(heading.textContent || "section");
        let id = base;
        let i = 1;
        while (used.has(id)) {
          id = `${base}-${i++}`;
        }
        heading.id = id;
      }
      used.add(heading.id);
      if (!heading.querySelector(".anchor-link")) {
        const link = document.createElement("a");
        link.className = "anchor-link";
        link.href = `#${heading.id}`;
        link.textContent = "#";
        link.setAttribute("aria-label", "Link to section");
        heading.appendChild(link);
      }
    });
  };

  const buildToc = () => {
    if (!tocContainer || !contentRoot) return;
    tocContainer.innerHTML = "";
    const headings = Array.from(contentRoot.querySelectorAll("h2, h3"));
    const list = document.createElement("ul");
    list.className = "toc";
    let currentSub = null;
    headings.forEach((heading) => {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent || "Section";
      link.dataset.target = heading.id;
      if (heading.tagName.toLowerCase() === "h2") {
        currentSub = null;
        li.appendChild(link);
        list.appendChild(li);
      } else {
        if (!currentSub) {
          currentSub = document.createElement("ul");
          currentSub.className = "toc";
          const last = list.lastElementChild;
          if (last) last.appendChild(currentSub);
        }
        li.appendChild(link);
        currentSub.appendChild(li);
      }
    });
    tocContainer.appendChild(list);
  };

  const clearHighlights = () => {
    const marks = contentRoot?.querySelectorAll("mark.search-hit");
    marks?.forEach((mark) => {
      const text = document.createTextNode(mark.textContent || "");
      mark.replaceWith(text);
    });
  };

  const highlightMatches = (rootNode, term) => {
    if (!rootNode || !term) return;
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue.toLowerCase().includes(term)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentElement?.closest("script, style, nav, aside")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      const idx = lower.indexOf(term);
      if (idx === -1) return;
      const before = document.createTextNode(text.slice(0, idx));
      const match = document.createElement("mark");
      match.className = "search-hit";
      match.textContent = text.slice(idx, idx + term.length);
      const after = document.createTextNode(text.slice(idx + term.length));
      const frag = document.createDocumentFragment();
      frag.appendChild(before);
      frag.appendChild(match);
      frag.appendChild(after);
      node.replaceWith(frag);
    });
  };

  const runSearch = () => {
    if (!contentRoot || !searchResults || !searchPopover) return;
    const termRaw = searchInput?.value.trim() || "";
    const term = termRaw.toLowerCase();
    searchResults.innerHTML = "";
    clearHighlights();
    if (!term) {
      searchPopover.classList.remove("open");
      if (searchCount) searchCount.textContent = "0 results";
      return;
    }
    const sections = Array.from(contentRoot.querySelectorAll("section"));
    let matches = 0;
    sections.forEach((section) => {
      const text = section.textContent?.toLowerCase() || "";
      if (!text.includes(term)) return;
      matches += 1;
      highlightMatches(section, term);
      const heading = section.querySelector("h2, h3");
      const label = heading?.textContent || section.id || "Result";
      const link = document.createElement("a");
      link.href = `#${section.id}`;
      link.textContent = label;
      const li = document.createElement("li");
      li.appendChild(link);
      searchResults.appendChild(li);
    });
    if (searchCount) {
      searchCount.textContent = `${matches} result${matches === 1 ? "" : "s"}`;
    }
    if (!matches) {
      const li = document.createElement("li");
      li.textContent = "No results found.";
      searchResults.appendChild(li);
    }
    searchPopover.classList.add("open");
  };

  const initScrollSpy = () => {
    if (!tocContainer) return;
    const links = Array.from(tocContainer.querySelectorAll("a[data-target]"));
    if (!links.length) return;
    const headings = links
      .map((link) => document.getElementById(link.dataset.target))
      .filter(Boolean);
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          links.forEach((link) => {
            link.classList.toggle("active", link.dataset.target === entry.target.id);
          });
        });
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 0.1 }
    );
    headings.forEach((heading) => observer.observe(heading));
  };

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const current = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
      setTheme(current === "dark" ? "light" : "dark");
    });
  }

  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", () => {
      document.body.classList.toggle("sidebar-hidden");
    });
  }

  if (searchInput) {
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch();
      }
      if (event.key === "Escape") {
        searchInput.value = "";
        runSearch();
        searchPopover?.classList.remove("open");
      }
    });
  }

  searchButton?.addEventListener("click", runSearch);
  clearButton?.addEventListener("click", () => {
    if (searchInput) searchInput.value = "";
    runSearch();
  });

  searchResults?.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.tagName === "A") {
      searchPopover?.classList.remove("open");
    }
  });

  document.addEventListener("click", (event) => {
    if (!searchPopover || !searchInput) return;
    const container = searchInput.closest(".search");
    if (container && !container.contains(event.target)) {
      searchPopover.classList.remove("open");
    }
  });

  initTheme();
  addAnchorLinks();
  buildToc();
  initScrollSpy();
  setTopbarHeight();
  window.addEventListener("resize", () => {
    setTopbarHeight();
  });
})();

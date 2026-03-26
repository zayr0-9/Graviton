(() => {
  if (window.__studyAChartsRendered) return;
  window.__studyAChartsRendered = true;

  const crossModel = [
    { name: "sonnet", a1: 1.0, b1: 0.6667, m2: 2.0, m2b: 22.0, n: 3, color: "#ef4444" },
    { name: "haiku", a1: 0.0, b1: 0.0, m2: 2.6667, m2b: 23.6667, n: 3, color: "#10b981" },
    { name: "gpt-5.1-codex-max", a1: 1.0, b1: 0.6667, m2: 0.0, m2b: 21.0, n: 3, color: "#eab308" },
    { name: "gemini-flash", a1: 1.0, b1: 0.5, m2: 0.0, m2b: 20.0, n: 2, color: "#06b6d4" },
    { name: "gemini-pro", a1: 1.0, b1: 1.0, m2: 4.0, m2b: 20.5, n: 2, color: "#f97316" },
    { name: "devstral", a1: 0.0, b1: 0.6667, m2: 0.0, m2b: 21.3333, n: 3, color: "#0ea5e9" },
    { name: "ministral", a1: 1.0, b1: 0.3333, m2: 3.6667, m2b: 24.6667, n: 3, color: "#1e3a8a" },
    { name: "glm-5", a1: 1.0, b1: 1.0, m2: 1.0, m2b: 26.5, n: 2, color: "#0ea5e9" },
    { name: "mimo-omni", a1: 0.6667, b1: 1.0, m2: 1.3333, m2b: 20.3333, n: 3, color: "#0ea5e9" },
    { name: "mimo-pro", a1: 0.0, b1: 1.0, m2: 0.0, m2b: 21.0, n: 1, color: "#84cc16" },
  ];

  const labels = crossModel.map((d) => (d.n < 3 ? `${d.name}*` : d.name));
  const colors = crossModel.map((d) => d.color);

  const renderFallback = (containerId, xKey, yKey, xMax, yMax, xLabel, yLabel) => {
    const root = document.getElementById(containerId);
    if (!root) return;
    const w = 640;
    const h = 390;
    const l = 62;
    const r = 18;
    const t = 20;
    const b = 48;
    const iw = w - l - r;
    const ih = h - t - b;
    const x = (v) => l + (Math.max(0, Math.min(xMax, v)) / xMax) * iw;
    const y = (v) => t + ih - (Math.max(0, Math.min(yMax, v)) / yMax) * ih;

    let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${root.getAttribute("aria-label") || "fallback plot"}">`;
    for (let i = 0; i <= 5; i++) {
      const gx = l + (iw * i) / 5;
      const gy = t + (ih * i) / 5;
      svg += `<line x1="${gx}" y1="${t}" x2="${gx}" y2="${t + ih}" stroke="#eceff3" />`;
      svg += `<line x1="${l}" y1="${gy}" x2="${l + iw}" y2="${gy}" stroke="#eceff3" />`;
    }
    svg += `<line x1="${l}" y1="${t + ih}" x2="${l + iw}" y2="${t + ih}" stroke="#9ca3af" />`;
    svg += `<line x1="${l}" y1="${t}" x2="${l}" y2="${t + ih}" stroke="#9ca3af" />`;
    svg += `<text x="${l + iw / 2}" y="${h - 10}" text-anchor="middle" font-size="12" fill="#374151">${xLabel}</text>`;
    svg += `<text x="16" y="16" font-size="12" fill="#374151">${yLabel}</text>`;

    crossModel.forEach((d, i) => {
      const cx = x(d[xKey]);
      const cy = y(d[yKey]);
      svg += `<circle cx="${cx}" cy="${cy}" r="6" fill="${d.color}" stroke="#111827" stroke-width="0.8" />`;
      svg += `<text x="${cx + 8}" y="${cy - 6}" font-size="10" fill="#111827">${labels[i]}</text>`;
    });

    svg += `</svg>`;
    root.innerHTML = svg;
  };

  const renderWithPlotly = () => {
    if (!window.Plotly || typeof window.Plotly.newPlot !== "function") return false;

    const baseConfig = { responsive: true, displayModeBar: false, staticPlot: true };
    const baseLayout = {
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      margin: { l: 58, r: 16, t: 12, b: 48 },
      font: { family: "Inter, system-ui, sans-serif", color: "#111827", size: 11 },
    };

    const mkTrace = (x, y) => ({
      type: "scatter",
      mode: "markers+text",
      x,
      y,
      text: labels,
      textposition: "top center",
      marker: { size: 11, color: colors, line: { color: "#111827", width: 0.8 } },
    });

    const safePlot = (node, traces, layout, fallbackArgs) => {
      try {
        const p = window.Plotly.newPlot(node, traces, layout, baseConfig);

        const ensureVisible = () => {
          const hasPlotlyContent = !!node.querySelector(".main-svg, .svg-container, .gl-container");
          if (!hasPlotlyContent) {
            renderFallback(...fallbackArgs);
          }
        };

        Promise.resolve(p)
          .then(() => {
            try {
              if (window.Plotly?.Plots?.resize) {
                setTimeout(() => window.Plotly.Plots.resize(node), 50);
              }
            } catch {
              /* no-op */
            }
            setTimeout(ensureVisible, 200);
          })
          .catch(() => renderFallback(...fallbackArgs));

        // Safety net for silent failures/hangs
        setTimeout(ensureVisible, 1200);

        return true;
      } catch {
        renderFallback(...fallbackArgs);
        return false;
      }
    };

    let used = false;

    const a2Node = document.getElementById("panel-a2-plot");
    if (a2Node) {
      used =
        safePlot(
          a2Node,
          [mkTrace(crossModel.map((d) => d.a1), crossModel.map((d) => d.b1))],
          {
            ...baseLayout,
            xaxis: { title: "A1 same-session endorsement rate", range: [0, 1], tick0: 0, dtick: 0.2, gridcolor: "#eceff3", zeroline: false },
            yaxis: { title: "B1 fresh-session endorsement rate", range: [0, 1], tick0: 0, dtick: 0.2, gridcolor: "#eceff3", zeroline: false },
          },
          ["panel-a2-plot", "a1", "b1", 1, 1, "A1 same-session endorsement rate", "B1 fresh-session endorsement rate"]
        ) || used;
    }

    const b2Node = document.getElementById("panel-b2-plot");
    if (b2Node) {
      used =
        safePlot(
          b2Node,
          [mkTrace(crossModel.map((d) => d.m2), crossModel.map((d) => d.m2b))],
          {
            ...baseLayout,
            xaxis: { title: "Mean M2 contradiction severity", range: [0, 6], tick0: 0, dtick: 1, gridcolor: "#eceff3", zeroline: false },
            yaxis: { title: "Mean M2b material-gap severity", range: [0, 30], tick0: 0, dtick: 5, gridcolor: "#eceff3", zeroline: false },
          },
          ["panel-b2-plot", "m2", "m2b", 6, 30, "Mean M2 contradiction severity", "Mean M2b material-gap severity"]
        ) || used;
    }

    return used;
  };

  const renderAll = () => {
    // Always ensure non-blank first
    renderFallback("panel-a2-plot", "a1", "b1", 1, 1, "A1 same-session endorsement rate", "B1 fresh-session endorsement rate");
    renderFallback("panel-b2-plot", "m2", "m2b", 6, 30, "Mean M2 contradiction severity", "Mean M2b material-gap severity");

    // Then upgrade to library rendering if available and stable
    renderWithPlotly();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderAll, { once: true });
  } else {
    renderAll();
  }
})();

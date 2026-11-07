// Fuel stats dashboard. Every chart is native SVG drawn here; all metrics come
// from /data.json so the browser only scales, draws, and filters.

const COLORS = {
  lime: "#d7f64f",
  winter: "#3987e5",
  spring: "#199e70",
  summer: "#b5174a",
  fall: "#d95926",
  dot: "#77777c",
  warn: "#f2b84b",
  plot: "#0a0a0b",
  panel: "#1f1f21",
};
const SEASON_COLOR = {
  Winter: COLORS.winter,
  Spring: COLORS.spring,
  Summer: COLORS.summer,
  Fall: COLORS.fall,
};
const TIMELINE_PAGE_SIZE = 9;
const DAY = 86400000;
const SVG_NS = "http://www.w3.org/2000/svg";

const state = { data: null, range: "all", timelinePage: 0 };
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- formatting

const toTime = (iso) => new Date(`${iso}T00:00:00`).getTime();
const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short" });
const fullDate = (iso) => dateFmt.format(toTime(iso));
const shortDate = (iso) => dayFmt.format(toTime(iso));
const whole = (n) => Math.round(n).toLocaleString("en-US");
const fixed = (n, digits = 1) => n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const money = (n, digits = 2) => `$${fixed(n, digits)}`;
const orDash = (value, format) => (value === null || value === undefined ? "–" : format(value));

// ---------------------------------------------------------------- SVG helpers

function svgEl(tag, attrs = {}, parent = null, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

function linear(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

function niceTicks(min, max, count = 5) {
  const rough = (max - min) / Math.max(count - 1, 1) || 1;
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = [1, 2, 2.5, 5, 10].find((step) => step * power >= rough) * power;
  const start = Math.floor(min / unit) * unit;
  const end = Math.ceil(max / unit) * unit;
  const ticks = [];
  for (let value = start; value <= end + unit / 2; value += unit) ticks.push(Number(value.toFixed(6)));
  return ticks;
}

function timeTicks(start, end, width) {
  const spanDays = (end - start) / DAY;
  const room = Math.max(Math.floor(width / 64), 2);
  const stepMonths = [1, 2, 3, 6, 12, 24].find((months) => spanDays / 30.4 / months <= room) ?? 36;
  const ticks = [];
  const cursor = new Date(start);
  cursor.setDate(1);
  cursor.setMonth(Math.ceil(cursor.getMonth() / stepMonths) * stepMonths);
  while (cursor.getTime() <= end) {
    if (cursor.getTime() >= start) {
      const label = stepMonths >= 12 || cursor.getMonth() === 0
        ? String(cursor.getFullYear())
        : monthFmt.format(cursor);
      ticks.push({ time: cursor.getTime(), label });
    }
    cursor.setMonth(cursor.getMonth() + stepMonths);
  }
  return ticks;
}

function createChart(id, height, margin, label) {
  const host = $(id);
  host.replaceChildren();
  const width = Math.max(host.clientWidth, 260);
  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label }, host);
  return {
    svg,
    width,
    height,
    left: margin.left,
    right: width - margin.right,
    top: margin.top,
    bottom: height - margin.bottom,
  };
}

function drawYAxis(chart, y, ticks, format) {
  for (const tick of ticks) {
    const py = Math.round(y(tick)) + 0.5;
    svgEl("line", { class: "grid-line", x1: chart.left, x2: chart.right, y1: py, y2: py }, chart.svg);
    svgEl("text", { class: "axis-text", x: chart.left - 8, y: py + 4, "text-anchor": "end" }, chart.svg, format(tick));
  }
}

function drawAxisUnit(chart, unit) {
  svgEl("text", { class: "axis-text", x: chart.left - 8, y: chart.top - 8, "text-anchor": "end" }, chart.svg, unit);
}

function drawTimeAxis(chart, x, ticks) {
  for (const tick of ticks) {
    const px = x(tick.time);
    if (px < chart.left - 1 || px > chart.right + 1) continue;
    const anchor = px > chart.right - 16 ? "end" : "middle";
    svgEl("text", { class: "axis-text", x: px, y: chart.bottom + 18, "text-anchor": anchor }, chart.svg, tick.label);
  }
}

function linePath(points) {
  return points.map(([px, py], index) => `${index ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join("");
}

function columnPath(px, py, width, baseline) {
  const radius = Math.min(4, width / 2, Math.max(baseline - py, 0));
  return `M${px} ${baseline}V${py + radius}Q${px} ${py} ${px + radius} ${py}`
    + `H${px + width - radius}Q${px + width} ${py} ${px + width} ${py + radius}V${baseline}Z`;
}

// ---------------------------------------------------------------- tooltip

function showTooltip(clientX, clientY, content) {
  const tip = $("tooltip");
  tip.replaceChildren();
  const title = document.createElement("div");
  title.className = "tip-title";
  title.textContent = content.title;
  tip.appendChild(title);
  for (const row of content.rows) {
    const line = document.createElement("div");
    line.className = "tip-row";
    if (row.color) {
      const key = document.createElement("i");
      key.className = "tip-key";
      key.style.background = row.color;
      line.appendChild(key);
    }
    const value = document.createElement("b");
    value.textContent = row.value;
    const name = document.createElement("span");
    name.textContent = row.label;
    line.append(value, name);
    tip.appendChild(line);
  }
  if (content.note) {
    const note = document.createElement("div");
    note.className = "tip-note";
    note.textContent = content.note;
    tip.appendChild(note);
  }
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  const left = clientX + 16 + box.width > window.innerWidth ? clientX - box.width - 16 : clientX + 16;
  const top = Math.min(Math.max(clientY - box.height / 2, 8), window.innerHeight - box.height - 8);
  tip.style.left = `${Math.max(left, 8)}px`;
  tip.style.top = `${top}px`;
}

const hideTooltip = () => { $("tooltip").hidden = true; };

// Hover and keyboard focus on a single mark show the same details.
function bindMark(node, content) {
  node.setAttribute("tabindex", "0");
  node.addEventListener("pointermove", (event) => showTooltip(event.clientX, event.clientY, content));
  node.addEventListener("pointerleave", hideTooltip);
  node.addEventListener("focus", () => {
    const box = node.getBoundingClientRect();
    showTooltip(box.right, box.top + box.height / 2, content);
  });
  node.addEventListener("blur", hideTooltip);
}

// A crosshair that snaps to the nearest point. Left and right arrows step through it.
function bindCrosshair(chart, points) {
  const { svg, left, right, top, bottom } = chart;
  const line = svgEl("line", { class: "crosshair", y1: top, y2: bottom, visibility: "hidden" }, svg);
  const marker = svgEl("circle", { r: 4, stroke: COLORS.plot, "stroke-width": 2, visibility: "hidden" }, svg);
  const area = svgEl("rect", {
    class: "hit-area", x: left, y: top, width: right - left, height: bottom - top, tabindex: 0,
  }, svg);
  let current = points.length - 1;

  const show = (index, clientX, clientY) => {
    current = index;
    const point = points[index];
    line.setAttribute("x1", point.x);
    line.setAttribute("x2", point.x);
    line.setAttribute("visibility", "visible");
    if (point.y !== undefined) {
      marker.setAttribute("cx", point.x);
      marker.setAttribute("cy", point.y);
      marker.setAttribute("fill", point.color ?? COLORS.lime);
      marker.setAttribute("visibility", "visible");
    } else {
      marker.setAttribute("visibility", "hidden");
    }
    showTooltip(clientX, clientY, point.tip);
  };
  const hide = () => {
    line.setAttribute("visibility", "hidden");
    marker.setAttribute("visibility", "hidden");
    hideTooltip();
  };
  const showAtPoint = (index) => {
    const box = svg.getBoundingClientRect();
    show(index, box.left + points[index].x, box.top + (top + bottom) / 2);
  };

  area.addEventListener("pointermove", (event) => {
    const px = event.clientX - svg.getBoundingClientRect().left;
    let nearest = 0;
    points.forEach((point, index) => {
      if (Math.abs(point.x - px) < Math.abs(points[nearest].x - px)) nearest = index;
    });
    show(nearest, event.clientX, event.clientY);
  });
  area.addEventListener("pointerleave", hide);
  area.addEventListener("blur", hide);
  area.addEventListener("focus", () => showAtPoint(current));
  area.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -1 : 1;
    showAtPoint(Math.min(Math.max(current + step, 0), points.length - 1));
  });
}

// ---------------------------------------------------------------- charts

function renderBubbles(summary) {
  const items = summary.bubbles;
  const height = window.innerWidth < 680 ? 240 : 290;
  const chart = createChart("chart-bubbles", height, { top: 16, right: 18, bottom: 28, left: 34 },
    "Bubble chart of MPG over time, colored by season. Values are in the fill-up log below.");
  const times = items.map((item) => toTime(item.date));
  const mpgs = items.map((item) => item.mpg);
  const ticks = niceTicks(Math.min(...mpgs) - 1, Math.max(...mpgs) + 1, 5);
  const padTime = ((Math.max(...times) - Math.min(...times)) / Math.max(items.length, 2)) * 0.7;
  const domainStart = Math.min(...times) - padTime;
  const domainEnd = Math.max(...times) + padTime;
  const x = linear([domainStart, domainEnd], [chart.left, chart.right]);
  const y = linear([ticks[0], ticks[ticks.length - 1]], [chart.bottom, chart.top]);
  const maxMiles = Math.max(...items.map((item) => item.miles));
  const maxRadius = Math.min(26, Math.max(((chart.right - chart.left) / items.length) * 0.95, 9));
  const radius = (miles) => Math.max(Math.sqrt(miles / maxMiles) * maxRadius, 4);

  drawYAxis(chart, y, ticks, (tick) => String(tick));
  drawAxisUnit(chart, "MPG");
  drawTimeAxis(chart, x, timeTicks(domainStart, domainEnd, chart.right - chart.left));
  for (const time of times) {
    const px = Math.round(x(time)) + 0.5;
    svgEl("line", { class: "track-line", x1: px, x2: px, y1: chart.top, y2: chart.bottom }, chart.svg);
  }

  const order = items.map((_, index) => index).sort((a, b) => items[b].miles - items[a].miles);
  for (const index of order) {
    const item = items[index];
    svgEl("circle", {
      class: "mark",
      cx: x(times[index]),
      cy: y(item.mpg),
      r: radius(item.miles),
      fill: SEASON_COLOR[item.season],
      stroke: COLORS.plot,
      "stroke-width": 2,
    }, chart.svg);
  }

  const best = items.reduce((top, item) => (item.mpg > top.mpg ? item : top), items[0]);
  const worst = items.reduce((low, item) => (item.mpg < low.mpg ? item : low), items[0]);
  for (const [item, above] of [[best, true], [worst, false]]) {
    const px = x(toTime(item.date));
    const offset = radius(item.miles) + 7;
    const anchor = px < chart.left + 34 ? "start" : px > chart.right - 34 ? "end" : "middle";
    svgEl("text", {
      class: "label-text", x: px, y: above ? y(item.mpg) - offset : y(item.mpg) + offset + 9, "text-anchor": anchor,
    }, chart.svg, `${fixed(item.mpg)} MPG`);
  }

  for (const [index, item] of items.entries()) {
    const hit = svgEl("circle", {
      class: "hit-area", cx: x(times[index]), cy: y(item.mpg), r: Math.max(radius(item.miles), 13),
    }, chart.svg);
    bindMark(hit, {
      title: item.label,
      rows: [
        { value: `${fixed(item.mpg)} MPG`, label: "", color: SEASON_COLOR[item.season] },
        { value: `${whole(item.miles)} mi`, label: `on ${fixed(item.gallons)} gal` },
        { value: String(item.fills), label: item.fills === 1 ? "fill-up" : "fill-ups" },
      ],
    });
  }
}

function renderMilesPerDay(rows) {
  const points = rows.filter((row) => row.miles_per_day_90 !== null);
  const chart = createChart("chart-mpd", 196, { top: 16, right: 44, bottom: 22, left: 8 },
    "Area chart of the 90-day average of miles per day.");
  if (points.length < 2) return;
  const times = points.map((row) => toTime(row.date));
  const values = points.map((row) => row.miles_per_day_90);
  const x = linear([times[0], times[times.length - 1]], [chart.left, chart.right]);
  const y = linear([0, Math.max(...values) * 1.1], [chart.bottom, chart.top]);
  const coords = points.map((row, index) => [x(times[index]), y(values[index])]);

  svgEl("line", { class: "grid-line", x1: chart.left, x2: chart.right, y1: chart.bottom + 0.5, y2: chart.bottom + 0.5 }, chart.svg);
  drawTimeAxis(chart, x, timeTicks(times[0], times[times.length - 1], chart.right - chart.left));
  svgEl("path", {
    d: `${linePath(coords)}L${chart.right} ${chart.bottom}L${chart.left} ${chart.bottom}Z`,
    fill: COLORS.lime,
    "fill-opacity": 0.1,
  }, chart.svg);
  svgEl("path", { d: linePath(coords), fill: "none", stroke: COLORS.lime, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, chart.svg);

  const [endX, endY] = coords[coords.length - 1];
  svgEl("circle", { cx: endX, cy: endY, r: 4, fill: COLORS.lime, stroke: COLORS.panel, "stroke-width": 2 }, chart.svg);
  svgEl("text", { class: "label-text", x: endX + 9, y: endY + 4 }, chart.svg, fixed(values[values.length - 1]));

  bindCrosshair(chart, points.map((row, index) => ({
    x: coords[index][0],
    y: coords[index][1],
    tip: {
      title: fullDate(row.date),
      rows: [{ value: `${fixed(row.miles_per_day_90)} mi/day`, label: "90-day average", color: COLORS.lime }],
    },
  })));
}

function renderTanks(rows) {
  const chart = createChart("chart-tanks", 300, { top: 22, right: 68, bottom: 28, left: 38 },
    "Line chart of MPG for every tank with a five-tank average. Values are in the fill-up log below.");
  const trusted = rows.filter((row) => !row.excluded_from_mpg);
  const values = trusted.map((row) => row.mpg);
  const ticks = niceTicks(Math.min(...values) - 1, Math.max(...values) + 1, 6);
  const times = rows.map((row) => toTime(row.date));
  const x = linear([times[0], times[times.length - 1]], [chart.left, chart.right]);
  const y = linear([ticks[0], ticks[ticks.length - 1]], [chart.bottom, chart.top]);

  drawYAxis(chart, y, ticks, (tick) => String(tick));
  drawAxisUnit(chart, "MPG");
  drawTimeAxis(chart, x, timeTicks(times[0], times[times.length - 1], chart.right - chart.left));

  for (const row of trusted) {
    svgEl("circle", { cx: x(toTime(row.date)), cy: y(row.mpg), r: 4, fill: COLORS.dot, "fill-opacity": 0.55 }, chart.svg);
  }

  const rolling = rows.filter((row) => row.mpg_rolling !== null);
  const coords = rolling.map((row) => [x(toTime(row.date)), y(row.mpg_rolling)]);
  if (coords.length > 1) {
    svgEl("path", { d: linePath(coords), fill: "none", stroke: COLORS.lime, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, chart.svg);
    const [endX, endY] = coords[coords.length - 1];
    svgEl("circle", { cx: endX, cy: endY, r: 4, fill: COLORS.lime, stroke: COLORS.panel, "stroke-width": 2 }, chart.svg);
    svgEl("text", { class: "label-text", x: endX + 9, y: endY + 4 }, chart.svg, `${fixed(rolling[rolling.length - 1].mpg_rolling)} MPG`);
  }

  // Excluded tanks would crush the scale, so they are pinned to the top edge.
  for (const row of rows.filter((item) => item.excluded_from_mpg)) {
    svgEl("circle", {
      cx: x(toTime(row.date)), cy: chart.top - 8, r: 4, fill: "none", stroke: COLORS.warn, "stroke-width": 2,
    }, chart.svg);
  }

  bindCrosshair(chart, rows.map((row, index) => {
    const flag = row.flags[0];
    return {
      x: x(times[index]),
      y: row.excluded_from_mpg ? chart.top - 8 : y(row.mpg),
      color: row.excluded_from_mpg ? COLORS.warn : COLORS.lime,
      tip: {
        title: fullDate(row.date),
        rows: [
          { value: `${fixed(row.mpg)} MPG`, label: row.excluded_from_mpg ? "excluded" : "this tank", color: COLORS.dot },
          ...(row.mpg_rolling === null ? [] : [{ value: `${fixed(row.mpg_rolling)} MPG`, label: "5-tank average", color: COLORS.lime }]),
          { value: `${whole(row.miles)} mi`, label: `on ${fixed(row.gallons)} gal` },
        ],
        note: flag ? flag.note : null,
      },
    };
  }));
}

function renderMonths(summary) {
  const items = summary.month_of_year;
  const chart = createChart("chart-months", 272, { top: 22, right: 8, bottom: 28, left: 30 },
    "Column chart of MPG for each calendar month, colored by season.");
  const valid = items.filter((item) => item.mpg !== null);
  const ticks = niceTicks(0, Math.max(...valid.map((item) => item.mpg)) * 1.05, 4);
  const y = linear([0, ticks[ticks.length - 1]], [chart.bottom, chart.top]);
  const slot = (chart.right - chart.left) / items.length;
  const barWidth = Math.min(24, slot - 4);
  const best = valid.reduce((top, item) => (item.mpg > top.mpg ? item : top), valid[0]);
  const worst = valid.reduce((low, item) => (item.mpg < low.mpg ? item : low), valid[0]);

  drawYAxis(chart, y, ticks, (tick) => String(tick));
  drawAxisUnit(chart, "MPG");
  items.forEach((item, index) => {
    const center = chart.left + slot * (index + 0.5);
    svgEl("text", { class: "axis-text", x: center, y: chart.bottom + 18, "text-anchor": "middle" }, chart.svg, slot < 26 ? item.month[0] : item.month);
    if (item.mpg === null) return;
    const top = y(item.mpg);
    svgEl("path", { class: "mark", d: columnPath(center - barWidth / 2, top, barWidth, chart.bottom), fill: SEASON_COLOR[item.season] }, chart.svg);
    if (item === best || item === worst) {
      svgEl("text", { class: "label-text", x: center, y: top - 6, "text-anchor": "middle" }, chart.svg, slot < 48 ? fixed(item.mpg) : `${fixed(item.mpg)} MPG`);
    }
    const hit = svgEl("rect", { class: "hit", x: center - slot / 2, y: chart.top, width: slot, height: chart.bottom - chart.top, rx: 4 }, chart.svg);
    bindMark(hit, {
      title: `${item.month} · ${item.season.toLowerCase()}`,
      rows: [
        { value: `${fixed(item.mpg)} MPG`, label: "", color: SEASON_COLOR[item.season] },
        { value: String(item.fills), label: item.fills === 1 ? "fill-up" : "fill-ups" },
      ],
    });
  });
}

function renderPrice(projection) {
  const { history, curve } = projection.price;
  const chart = createChart("chart-price", 300, { top: 18, right: 52, bottom: 28, left: 44 },
    "Pump price with a 60-day average and a projected trend with an 80 percent range.");
  const start = toTime(history[0].date);
  const origin = toTime(projection.origin);
  const end = toTime(curve[curve.length - 1].date);
  const all = [...history.map((row) => row.price), ...curve.map((row) => row.low), ...curve.map((row) => row.high)];
  const ticks = niceTicks(Math.min(...all), Math.max(...all), 6);
  const x = linear([start, end], [chart.left, chart.right]);
  const y = linear([ticks[0], ticks[ticks.length - 1]], [chart.bottom, chart.top]);

  drawYAxis(chart, y, ticks, (tick) => money(tick));
  drawTimeAxis(chart, x, timeTicks(start, end, chart.right - chart.left));

  const upper = curve.map((row) => [x(toTime(row.date)), y(row.high)]);
  const lower = curve.map((row) => [x(toTime(row.date)), y(row.low)]).reverse();
  svgEl("path", { d: `${linePath(upper)}${linePath(lower).replace("M", "L")}Z`, fill: COLORS.lime, "fill-opacity": 0.1 }, chart.svg);

  const originX = Math.round(x(origin)) + 0.5;
  svgEl("line", { class: "crosshair", x1: originX, x2: originX, y1: chart.top, y2: chart.bottom }, chart.svg);
  svgEl("text", { class: "note-text", x: originX - 6, y: chart.top + 10, "text-anchor": "end" }, chart.svg, "Last fill");

  for (const row of history) {
    svgEl("circle", { cx: x(toTime(row.date)), cy: y(row.price), r: 4, fill: COLORS.dot, "fill-opacity": 0.75 }, chart.svg);
  }
  const average = history.filter((row) => row.ma60 !== null).map((row) => [x(toTime(row.date)), y(row.ma60)]);
  svgEl("path", { d: linePath(average), fill: "none", stroke: COLORS.lime, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, chart.svg);

  const trend = curve.map((row) => [x(toTime(row.date)), y(row.price)]);
  svgEl("path", { d: linePath(trend), fill: "none", stroke: COLORS.lime, "stroke-width": 2, "stroke-dasharray": "6 5", "stroke-linecap": "round" }, chart.svg);
  const [endX, endY] = trend[trend.length - 1];
  svgEl("circle", { cx: endX, cy: endY, r: 4, fill: COLORS.lime, stroke: COLORS.panel, "stroke-width": 2 }, chart.svg);
  svgEl("text", { class: "label-text", x: endX + 8, y: endY + 4 }, chart.svg, money(curve[curve.length - 1].price));

  const points = [
    ...history.map((row) => ({
      x: x(toTime(row.date)),
      y: y(row.price),
      color: COLORS.dot,
      tip: {
        title: fullDate(row.date),
        rows: [
          { value: money(row.price, 3), label: "pump price", color: COLORS.dot },
          { value: money(row.ma60, 3), label: "60-day average", color: COLORS.lime },
        ],
      },
    })),
    ...curve.slice(1).map((row) => ({
      x: x(toTime(row.date)),
      y: y(row.price),
      tip: {
        title: `${fullDate(row.date)} (+${row.day} days)`,
        rows: [
          { value: money(row.price), label: "projected", color: COLORS.lime },
          { value: `${money(row.low)}–${money(row.high)}`, label: "80% range" },
        ],
      },
    })),
  ];
  bindCrosshair(chart, points);
}

function renderSpend(projection) {
  const { history, windows, trailing_avg: average } = projection.spend;
  const chart = createChart("chart-spend", 300, { top: 22, right: 8, bottom: 28, left: 40 },
    "Column chart of spend in 30-day windows, ending with three projected windows.");
  const items = [
    ...history.map((row) => ({ ...row, projected: false })),
    ...windows.map((row) => ({ ...row, projected: true })),
  ];
  const peak = Math.max(...items.map((item) => item.high ?? item.spend));
  const ticks = niceTicks(0, peak * 1.05, 5);
  const y = linear([0, ticks[ticks.length - 1]], [chart.bottom, chart.top]);
  const slot = (chart.right - chart.left) / items.length;
  const barWidth = Math.min(14, Math.max(slot - 6, 3));

  drawYAxis(chart, y, ticks, (tick) => `$${tick}`);

  const labelEvery = Math.ceil(items.length / Math.max(Math.floor((chart.right - chart.left) / 52), 2));
  items.forEach((item, index) => {
    const center = chart.left + slot * (index + 0.5);
    const distanceFromEnd = items.length - 1 - index;
    if (distanceFromEnd % labelEvery === 0) {
      svgEl("text", { class: "axis-text", x: center, y: chart.bottom + 18, "text-anchor": "middle" }, chart.svg, monthFmt.format(toTime(item.end)));
    }
    if (item.spend > 0) {
      svgEl("path", {
        class: "mark",
        d: columnPath(center - barWidth / 2, y(item.spend), barWidth, chart.bottom),
        fill: COLORS.lime,
        "fill-opacity": item.projected ? 0.38 : 0.92,
      }, chart.svg);
    }
    if (item.projected) {
      svgEl("line", { x1: center, x2: center, y1: y(item.low), y2: y(item.high), stroke: "#f4f4f2", "stroke-width": 1.5, "stroke-linecap": "round" }, chart.svg);
    }
    const hit = svgEl("rect", { class: "hit", x: center - slot / 2, y: chart.top, width: slot, height: chart.bottom - chart.top, rx: 3 }, chart.svg);
    bindMark(hit, {
      title: `${shortDate(item.start)} – ${shortDate(item.end)}`,
      rows: item.projected
        ? [
          { value: money(item.spend), label: "projected", color: COLORS.lime },
          { value: `${money(item.low, 0)}–${money(item.high, 0)}`, label: "price range" },
        ]
        : [
          { value: money(item.spend), label: "spent", color: COLORS.lime },
          { value: String(item.fills), label: item.fills === 1 ? "fill-up" : "fill-ups" },
        ],
    });
  });

  const lastProjected = items[items.length - 1];
  svgEl("text", {
    class: "label-text", x: chart.right, y: y(lastProjected.high) - 7, "text-anchor": "end",
  }, chart.svg, money(lastProjected.spend, 0));

  const avgY = Math.round(y(average)) + 0.5;
  svgEl("line", { class: "crosshair", x1: chart.left, x2: chart.right, y1: avgY, y2: avgY }, chart.svg);
  $("spend-average").textContent = `Last 12 windows averaged ${money(average, 0)}`;
}

// ---------------------------------------------------------------- page sections

function renderOverview(summary, rows) {
  const { projections } = state.data;
  $("subtitle").textContent = `${fullDate(summary.start)} – ${fullDate(summary.end)} · ${whole(summary.fills)} fill-ups`;
  $("hero-mpg").textContent = fixed(summary.mpg);
  $("hero-note").textContent = summary.excluded_tanks
    ? `Total miles over total gallons, skipping ${summary.excluded_tanks} implausible tanks`
    : "Total miles over total gallons";

  const price = projections.price;
  $("pump-value").textContent = money(price.last_price);
  const change = price.last_price - price.ma60;
  $("pump-note").textContent = `${change >= 0 ? "+" : "−"}${money(Math.abs(change))} vs 60-day avg`;

  const legend = $("season-legend");
  legend.replaceChildren();
  for (const season of summary.seasons) {
    const item = document.createElement("li");
    const key = document.createElement("span");
    key.className = "key key-swatch";
    key.style.background = SEASON_COLOR[season.season];
    const value = document.createElement("strong");
    value.textContent = `${fixed(season.mpg)} MPG`;
    item.append(key, `${season.season} `, value);
    legend.appendChild(item);
  }

  $("tile-miles").textContent = whole(summary.miles);
  $("tile-miles-note").textContent = `${fixed(summary.miles / summary.fills, 0)} mi per tank`;
  $("tile-gallons").textContent = whole(summary.gallons);
  $("tile-gallons-note").textContent = `${fixed(summary.gallons / summary.fills)} gal per fill-up`;
  $("tile-spend").textContent = summary.spend ? money(summary.spend, 0) : "–";
  $("tile-spend-note").textContent = summary.priced_fills === summary.fills
    ? "All fill-ups priced"
    : `Only ${summary.priced_fills} of ${summary.fills} fill-ups have prices`;
  $("tile-mpd").textContent = fixed(summary.miles_per_day);
  $("tile-mpd-note").textContent = `Longest gap ${summary.longest_gap.days} days`;

  $("mini-cpm").textContent = orDash(summary.cost_per_mile, (value) => `${fixed(value * 100)}¢`);
  $("mini-gap").textContent = fixed(summary.avg_days_between);
  setMini("mini-best", `${fixed(summary.best_tank.mpg)} MPG `, fullDate(summary.best_tank.date));
  setMini("mini-worst", `${fixed(summary.worst_tank.mpg)} MPG `, fullDate(summary.worst_tank.date));
  const discounts = summary.discounted_fills;
  setMini("mini-saved", `${money(summary.saved)} `, `on ${discounts} ${discounts === 1 ? "fill-up" : "fill-ups"}`);

  renderBubbles(summary);
  renderMilesPerDay(rows);
}

function setMini(id, value, detail) {
  const small = document.createElement("small");
  small.textContent = detail;
  $(id).replaceChildren(value, small);
}

function timelineItem(row) {
  const item = document.createElement("li");
  item.className = "tl-item";

  const time = document.createElement("div");
  time.className = "tl-date";
  const day = document.createElement("b");
  day.textContent = shortDate(row.date);
  time.append(day, row.date.slice(0, 4));

  const card = document.createElement("div");
  card.className = "tl-card";
  const flagged = row.flags.length > 0;
  const icon = document.createElement("span");
  icon.className = flagged ? "tl-icon flagged" : "tl-icon";
  icon.textContent = flagged ? "!" : "✓";
  icon.setAttribute("aria-label", flagged ? "Flagged" : "Clean");

  const body = document.createElement("div");
  const title = document.createElement("div");
  title.className = "tl-title";
  title.textContent = row.total_spent === null
    ? `${fixed(row.gallons, 2)} gal`
    : `${money(row.total_spent)} · ${fixed(row.gallons, 2)} gal`;
  const sub = document.createElement("div");
  sub.className = "tl-sub";
  const mpg = row.excluded_from_mpg ? "MPG excluded" : `${fixed(row.mpg)} MPG`;
  sub.textContent = `${mpg} · ${whole(row.miles)} mi`;
  body.append(title, sub);

  card.append(icon, body);
  item.append(time, card);
  return item;
}

function timelineMarker(text, soft, trailing) {
  const item = document.createElement("li");
  item.className = "tl-marker";
  const pill = document.createElement("span");
  pill.className = soft ? "tl-pill soft" : "tl-pill";
  pill.textContent = text;
  item.append(pill, trailing);
  return item;
}

function renderTimeline(rows) {
  const newest = [...rows].reverse();
  const pages = Math.max(Math.ceil(newest.length / TIMELINE_PAGE_SIZE), 1);
  state.timelinePage = Math.min(state.timelinePage, pages - 1);
  const start = state.timelinePage * TIMELINE_PAGE_SIZE;
  const visible = newest.slice(start, start + TIMELINE_PAGE_SIZE);

  $("timeline-page").textContent = String(state.timelinePage + 1);
  $("timeline-prev").disabled = state.timelinePage === 0;
  $("timeline-next").disabled = state.timelinePage >= pages - 1;
  $("timeline-label").textContent = visible.length
    ? `${shortDate(visible[visible.length - 1].date)} – ${shortDate(visible[0].date)}`
    : "";

  const list = $("timeline-list");
  list.replaceChildren();
  if (state.timelinePage === 0) {
    const { next_fill: next } = state.data.projections;
    list.appendChild(timelineMarker(`Next fill ~${shortDate(next.date)}`, true, ""));
    list.appendChild(timelineMarker(`Today, ${shortDate(state.data.today)}`, false, ""));
  }
  visible.forEach((row) => list.appendChild(timelineItem(row)));
}

function renderInsights() {
  const list = $("insights");
  list.replaceChildren();
  for (const insight of state.data.insights) {
    const item = document.createElement("li");
    const title = document.createElement("b");
    title.textContent = insight.title;
    const body = document.createElement("span");
    body.textContent = insight.body;
    item.append(title, body);
    list.appendChild(item);
  }
}

function renderForecastCards(projection) {
  const host = $("forecast-cards");
  host.replaceChildren();
  const names = ["Next 30 days", "Days 31–60", "Days 61–90"];
  projection.spend.windows.forEach((window, index) => {
    const horizon = projection.price.horizons[index];
    const card = document.createElement("article");
    card.className = "forecast";

    const title = document.createElement("h3");
    title.textContent = `${names[index]} · ${shortDate(window.start)} – ${shortDate(window.end)}`;
    const spend = document.createElement("p");
    spend.className = "forecast-spend";
    spend.textContent = money(window.spend, 0);
    const range = document.createElement("p");
    range.className = "forecast-range";
    range.textContent = `${money(window.low, 0)}–${money(window.high, 0)} on price alone`;

    const details = document.createElement("dl");
    for (const [name, value] of [
      [`$/gal by ${shortDate(horizon.date)}`, money(horizon.price)],
      ["Miles", whole(window.miles)],
      ["Gallons", fixed(window.gallons)],
    ]) {
      const term = document.createElement("dt");
      term.textContent = name;
      const description = document.createElement("dd");
      description.textContent = value;
      details.append(term, description);
    }
    card.append(title, spend, range, details);
    host.appendChild(card);
  });
}

function renderMethod(projection) {
  const { price, spend } = projection;
  const test = price.backtest;
  const direction = price.slope_per_30d >= 0 ? "rising" : "falling";
  const total = spend.windows[spend.windows.length - 1].cumulative;
  const extra = spend.seasonal_total_90d - total;
  const entries = [
    ["Price trend. ", `A straight line through the ${price.points} fill-ups in the last ${price.window_days} days, ${direction} ${money(Math.abs(price.slope_per_30d))} per 30 days.`],
    ["Spend model. ", `${fixed(spend.miles_per_day)} mi/day over the last 12 months (lifetime ${fixed(spend.lifetime_miles_per_day)}), at ${fixed(spend.recent_mpg)} MPG from the last ${spend.recent_mpg_fills} trusted tanks.`],
    ["Seasonal risk. ", `Recent MPG ignores the season ahead. Using each season's own MPG, these 90 days cost ${money(spend.seasonal_total_90d, 0)}, which is ${money(Math.abs(extra), 0)} ${extra >= 0 ? "more" : "less"} than the ${money(total, 0)} projected here.`],
  ];
  if (test) {
    const verdict = test.trend_mae > test.last_price_mae
      ? "Assuming the last price holds has been slightly more accurate, so treat the trend as a direction, not a quote."
      : "That beats assuming the last price holds.";
    entries.push(["Track record. ", `Replayed over ${test.samples} past fill-ups, the trend missed the price ${test.horizon_days} days out by ${money(test.trend_mae)} on average, against ${money(test.last_price_mae)} for the last price. ${verdict}`]);
  }
  const list = $("method");
  list.replaceChildren();
  for (const [lead, text] of entries) {
    const item = document.createElement("li");
    const strong = document.createElement("b");
    strong.textContent = lead;
    item.append(strong, text);
    list.appendChild(item);
  }
}

function renderQuality() {
  const { quality, coverage } = state.data;
  const labels = { repaired: "Repaired", excluded: "Excluded", note: "Note" };
  const list = $("quality");
  list.replaceChildren();
  for (const entry of quality) {
    const item = document.createElement("li");
    const date = document.createElement("span");
    date.className = "quality-date";
    date.textContent = fullDate(entry.date);
    const tag = document.createElement("span");
    tag.className = "quality-tag";
    tag.textContent = labels[entry.severity];
    const note = document.createElement("span");
    note.textContent = entry.note;
    item.append(date, tag, note);
    list.appendChild(item);
  }
  const item = document.createElement("li");
  const date = document.createElement("span");
  date.className = "quality-date";
  date.textContent = "Spend";
  const tag = document.createElement("span");
  tag.className = "quality-tag";
  tag.textContent = "Coverage";
  const note = document.createElement("span");
  note.textContent = `Prices exist for ${coverage.priced_fills} of ${coverage.fills} fill-ups, continuously since ${fullDate(coverage.first_priced)}. Spend and cost figures cover priced fill-ups only.`;
  item.append(date, tag, note);
  list.appendChild(item);
}

function renderLog(rows) {
  const body = $("log-body");
  body.replaceChildren();
  for (const row of [...rows].reverse()) {
    const tr = document.createElement("tr");
    const cells = [
      [fullDate(row.date), ""],
      [fixed(row.gallons, 3), "num"],
      [fixed(row.miles), "num"],
      [row.excluded_from_mpg ? `${fixed(row.mpg)}*` : fixed(row.mpg), "num"],
      [row.days ? String(row.days) : "–", "num"],
      [orDash(row.miles_per_day, (value) => fixed(value)), "num"],
      [orDash(row.total_spent, (value) => money(value)), "num"],
      [orDash(row.price, (value) => money(value, 3)), "num"],
      [row.flags.map((flag) => flag.note).join(" "), ""],
    ];
    for (const [text, className] of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      if (className) td.className = className;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

// ---------------------------------------------------------------- orchestration

function rowsInRange() {
  const { start } = state.data.ranges[state.range];
  return state.data.rows.filter((row) => row.date >= start);
}

function renderScoped() {
  const summary = state.data.ranges[state.range];
  const rows = rowsInRange();
  renderOverview(summary, rows);
  renderTimeline(rows);
  renderTanks(rows);
  renderMonths(summary);
  renderLog(rows);
}

function renderCharts() {
  if (!state.data) return;
  const summary = state.data.ranges[state.range];
  const rows = rowsInRange();
  renderBubbles(summary);
  renderMilesPerDay(rows);
  renderTanks(rows);
  renderMonths(summary);
  renderPrice(state.data.projections);
  renderSpend(state.data.projections);
}

function bindControls() {
  document.querySelectorAll(".range button").forEach((button) => {
    button.addEventListener("click", () => {
      state.range = button.dataset.range;
      state.timelinePage = 0;
      document.querySelectorAll(".range button").forEach((other) => {
        other.setAttribute("aria-pressed", String(other === button));
      });
      renderScoped();
    });
  });
  $("timeline-prev").addEventListener("click", () => {
    state.timelinePage -= 1;
    renderTimeline(rowsInRange());
  });
  $("timeline-next").addEventListener("click", () => {
    state.timelinePage += 1;
    renderTimeline(rowsInRange());
  });

  let lastWidth = window.innerWidth;
  let pending = 0;
  new ResizeObserver(() => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(renderCharts);
  }).observe(document.body);

  const links = new Map([...document.querySelectorAll(".rail nav a")].map((link) => [link.dataset.section, link]));
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      links.forEach((link, section) => link.classList.toggle("active", section === entry.target.id));
    }
  }, { rootMargin: "-30% 0px -60% 0px" });
  links.forEach((_, section) => observer.observe($(section)));
}

async function start() {
  bindControls();
  try {
    const response = await fetch("/data.json");
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new Error(problem.detail ?? `The server returned ${response.status}.`);
    }
    state.data = await response.json();
  } catch (error) {
    const banner = $("banner");
    banner.textContent = `Could not load the fuel log. ${error.message}`;
    banner.hidden = false;
    $("subtitle").textContent = "No data loaded";
    return;
  }
  renderScoped();
  renderInsights();
  renderForecastCards(state.data.projections);
  renderPrice(state.data.projections);
  renderSpend(state.data.projections);
  renderMethod(state.data.projections);
  renderQuality();
}

start();

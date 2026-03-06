const stage = document.getElementById("stage");
const queue = [];
let showing = false;

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

const ws = new WebSocket(wsUrl());

ws.addEventListener("message", (ev) => {
  let data;
  try { data = JSON.parse(ev.data); } catch { return; }
  if (!data?.type) return;

  if (data.type === "showImage" || data.type === "showText") {
    queue.push(data);
    pump();
  }
});

function pump() {
  if (showing) return;
  const next = queue.shift();
  if (!next) return;

  showing = true;

  const card = document.createElement("div");
  card.className = "card";

  const meta = document.createElement("div");
  meta.className = "meta";
  const ch = next.channel ? ` • ${next.channel.startsWith("@") ? next.channel : "@" + next.channel}` : "";
  meta.textContent = `@${next.by}${ch}`;
  card.appendChild(meta);

  if (next.type === "showText") {
    const t = document.createElement("div");
    t.className = "text";
    t.textContent = next.text || "";
    card.appendChild(t);
  } else {
    const img = document.createElement("img");
    img.className = "img";
    img.referrerPolicy = "no-referrer";
    img.src = next.url; // can be absolute or /uploads/...
    card.appendChild(img);
  }

  stage.appendChild(card);
  requestAnimationFrame(() => card.classList.add("in"));

  const duration = Math.max(1000, Math.min(20000, Number(next.durationMs || 10000)));
  setTimeout(() => {
    card.classList.remove("in");
    card.classList.add("out");
    setTimeout(() => {
      card.remove();
      showing = false;
      pump();
    }, 260);
  }, duration);
}

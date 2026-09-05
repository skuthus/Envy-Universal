//! Wheel interpolation so scrolling tracks the display refresh instead of
//! jumping a notch at a time.
//!
//! WebKitGTK on Linux delivers discrete line ticks even from a high-rate
//! mouse; without this a 120 Hz panel still looks like ~15 Hz. Those line
//! ticks are what the interpolation is for.
//!
//! Pixel-mode deltas (trackpads, high-res wheels) already arrive smooth and
//! high-rate, so we leave them to the platform: easing them only adds ~TAU of
//! latency, which reads as the scroll lagging behind your fingers.
//!
//! `prefers-reduced-motion: reduce` leaves the native wheel alone.

type Axis = { current: number; target: number }

interface Run {
  el: HTMLElement
  x: Axis
  y: Axis
  frame: number
  last: number
}

const runs = new Map<HTMLElement, Run>()

/// Settle time in seconds. Short enough to feel direct, long enough that a
/// 3-line wheel tick eases across several 120 Hz frames instead of snapping.
const TAU = 0.085

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function axisScrollable(overflow: string, scroll: number, client: number): boolean {
  if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') return false
  return scroll > client + 1
}

function canScroll(el: HTMLElement, dx: number, dy: number): boolean {
  const s = getComputedStyle(el)
  if (Math.abs(dy) >= Math.abs(dx)) {
    if (!axisScrollable(s.overflowY, el.scrollHeight, el.clientHeight)) return false
    if (dy > 0) return el.scrollTop + el.clientHeight < el.scrollHeight - 1
    if (dy < 0) return el.scrollTop > 0
    return false
  }
  if (!axisScrollable(s.overflowX, el.scrollWidth, el.clientWidth)) return false
  if (dx > 0) return el.scrollLeft + el.clientWidth < el.scrollWidth - 1
  if (dx < 0) return el.scrollLeft > 0
  return false
}

function scrollerFrom(start: EventTarget | null, dx: number, dy: number): HTMLElement | null {
  let n: Element | null = start instanceof Element ? start : null
  while (n) {
    if (n instanceof HTMLElement && canScroll(n, dx, dy)) return n
    n = n.parentElement
  }
  return null
}

function pxDelta(e: WheelEvent, el: HTMLElement): { x: number; y: number } {
  let x = e.deltaX
  let y = e.deltaY
  if (e.shiftKey && x === 0) {
    x = y
    y = 0
  }
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    const line = parseFloat(getComputedStyle(el).lineHeight)
    const step = Number.isFinite(line) && line > 0 ? line : 24
    x *= step
    y *= step
  } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    x *= el.clientWidth
    y *= el.clientHeight
  }
  return { x, y }
}

function clampRun(run: Run) {
  const maxX = Math.max(0, run.el.scrollWidth - run.el.clientWidth)
  const maxY = Math.max(0, run.el.scrollHeight - run.el.clientHeight)
  run.x.current = Math.min(maxX, Math.max(0, run.x.current))
  run.y.current = Math.min(maxY, Math.max(0, run.y.current))
  run.x.target = Math.min(maxX, Math.max(0, run.x.target))
  run.y.target = Math.min(maxY, Math.max(0, run.y.target))
}

function tick(run: Run, now: number) {
  const dt = Math.min(0.032, Math.max(0, (now - run.last) / 1000))
  run.last = now
  const k = 1 - Math.exp(-dt / TAU)
  const step = (a: Axis) => {
    a.current += (a.target - a.current) * k
    if (Math.abs(a.target - a.current) < 0.4) a.current = a.target
  }
  step(run.x)
  step(run.y)
  clampRun(run)
  run.el.scrollLeft = run.x.current
  run.el.scrollTop = run.y.current
  if (run.x.current !== run.x.target || run.y.current !== run.y.target) {
    run.frame = requestAnimationFrame((t) => tick(run, t))
  } else {
    run.frame = 0
    runs.delete(run.el)
  }
}

function onWheel(e: WheelEvent) {
  if (e.defaultPrevented || e.ctrlKey) return
  if (reducedMotion()) return
  const rawTarget = e.target
  if (rawTarget instanceof HTMLTextAreaElement || rawTarget instanceof HTMLSelectElement) return

  const signX = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX
  const signY = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY
  const el = scrollerFrom(e.target, signX, signY)
  if (!el) return

  // Pixel-mode deltas (trackpad, high-res wheel) already arrive smooth and
  // high-rate; the platform scrolls them directly, momentum and all. Easing
  // them only adds ~TAU of latency, so hand them back. Per-app sensitivity, if
  // ever wanted, belongs in Hyprland's `scroll_touchpad` window rule, not here.
  // Interpolation is reserved for discrete line/page ticks.
  if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) return

  const { x, y } = pxDelta(e, el)
  if (x === 0 && y === 0) return
  if (!canScroll(el, x, y)) return

  e.preventDefault()

  let run = runs.get(el)
  if (!run) {
    run = {
      el,
      x: { current: el.scrollLeft, target: el.scrollLeft },
      y: { current: el.scrollTop, target: el.scrollTop },
      frame: 0,
      last: performance.now(),
    }
    runs.set(el, run)
  } else if (Math.abs(el.scrollTop - run.y.current) > 2 || Math.abs(el.scrollLeft - run.x.current) > 2) {
    // Scrollbar drag or a programmatic jump moved the scroller out from
    // under the interpolation; catch up rather than fighting it.
    run.x.current = el.scrollLeft
    run.y.current = el.scrollTop
    run.x.target = el.scrollLeft
    run.y.target = el.scrollTop
  }
  run.x.target += x
  run.y.target += y
  clampRun(run)
  if (!run.frame) {
    run.last = performance.now()
    run.frame = requestAnimationFrame((t) => tick(run, t))
  }
}

/// Stop interpolating `el` so a keyboard or selection jump can land instantly.
/// Glides `el` to an absolute vertical position through the same animation
/// the wheel uses, so keyboard navigation that keeps moving the target — a
/// held arrow key advancing a row every 25 ms — reads as one continuous scroll
/// rather than a hop per row. Honours the reduced-motion preference by
/// jumping, exactly as the wheel path does.
export function smoothScrollTo(el: HTMLElement, top: number) {
  if (reducedMotion()) {
    cancelSmoothScroll(el)
    el.scrollTop = top
    return
  }
  let run = runs.get(el)
  if (!run) {
    run = {
      el,
      x: { current: el.scrollLeft, target: el.scrollLeft },
      y: { current: el.scrollTop, target: el.scrollTop },
      frame: 0,
      last: performance.now(),
    }
    runs.set(el, run)
  } else if (Math.abs(el.scrollTop - run.y.current) > 2 || Math.abs(el.scrollLeft - run.x.current) > 2) {
    // Something else moved the scroller since the last frame; continue from
    // where it actually is rather than snapping back to the animation's idea.
    run.x.current = el.scrollLeft
    run.y.current = el.scrollTop
    run.x.target = el.scrollLeft
  }
  run.y.target = top
  clampRun(run)
  if (!run.frame) {
    run.last = performance.now()
    run.frame = requestAnimationFrame((t) => tick(run as Run, t))
  }
}

/// Where `el` is scrolling to: the animation's target while one is running,
/// else its resting position.
export function scrollTarget(el: HTMLElement): number {
  return runs.get(el)?.y.target ?? el.scrollTop
}

export function cancelSmoothScroll(el: HTMLElement) {
  const run = runs.get(el)
  if (!run) return
  if (run.frame) cancelAnimationFrame(run.frame)
  runs.delete(el)
}

export function installSmoothScroll() {
  // A non-passive capture wheel listener forces Chromium to wait on the
  // main thread for every tick, which is what this interpolator is for on
  // WebKitGTK (discrete line events). WebView2 already delivers pixel
  // deltas and compositor-thread scrolling; installing this on Windows
  // makes the list and editor feel frozen.
  if (/Windows/i.test(navigator.userAgent)) return
  window.addEventListener('wheel', onWheel, { passive: false, capture: true })
}

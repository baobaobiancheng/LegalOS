<template>
  <div
    ref="root"
    class="legal-globe"
    aria-hidden="true"
  >
    <svg
      viewBox="0 0 820 520"
      role="presentation"
    >
      <defs>
        <clipPath id="globe-clip">
          <circle
            cx="248"
            cy="310"
            r="222"
          />
        </clipPath>
        <radialGradient
          id="globe-wash"
          cx="38%"
          cy="30%"
          r="72%"
        >
          <stop
            offset="0%"
            stop-color="#FFFFFF"
            stop-opacity="0.92"
          />
          <stop
            offset="54%"
            stop-color="#DCEBFF"
            stop-opacity="0.66"
          />
          <stop
            offset="100%"
            stop-color="#BFD7FB"
            stop-opacity="0.16"
          />
        </radialGradient>
      </defs>

      <g class="connection-field">
        <path
          class="flow-line"
          d="M26 232 C190 160 296 200 414 292 S650 394 806 244"
        />
        <path
          class="flow-line flow-line-delay"
          d="M8 358 C178 252 332 260 452 338 S666 398 820 332"
        />
        <path
          class="connection-line"
          d="M42 390 L116 314 L202 366 L286 274 L372 350 L470 292 L554 372 L648 318 L776 354"
        />
        <path
          class="connection-line connection-line-soft"
          d="M36 246 L116 314 L170 230 L286 274 L348 184 L470 292 L532 220 L648 318 L730 236"
        />
      </g>

      <g
        ref="globe"
        class="globe-body"
      >
        <circle
          cx="248"
          cy="310"
          r="222"
          fill="url(#globe-wash)"
          stroke="#8EB8F8"
          stroke-opacity="0.42"
        />
        <g
          clip-path="url(#globe-clip)"
          fill="none"
          stroke="#79A9F4"
          stroke-opacity="0.5"
        >
          <ellipse
            cx="248"
            cy="310"
            rx="102"
            ry="222"
          />
          <ellipse
            cx="248"
            cy="310"
            rx="174"
            ry="222"
          />
          <ellipse
            cx="248"
            cy="310"
            rx="222"
            ry="72"
          />
          <ellipse
            cx="248"
            cy="310"
            rx="222"
            ry="146"
          />
          <path d="M26 310 H470" />
          <path
            class="land-mass"
            d="M70 206 L106 168 150 176 178 152 226 166 250 206 238 246 196 262 178 306 132 316 98 286 62 274Z"
          />
          <path
            class="land-mass"
            d="M262 248 L298 212 350 224 382 260 430 282 450 326 408 350 378 402 328 418 302 374 272 342Z"
          />
          <path
            class="land-mass land-mass-soft"
            d="M112 338 L158 326 204 350 218 394 190 450 136 436 96 390Z"
          />
        </g>
      </g>

      <g class="network-nodes">
        <circle
          v-for="node in nodes"
          :key="`${node.x}-${node.y}`"
          class="network-node"
          :cx="node.x"
          :cy="node.y"
          :r="node.r"
        />
      </g>
    </svg>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { gsap } from 'gsap'

const root = ref<HTMLElement | null>(null)
const globe = ref<SVGGElement | null>(null)
let animationContext: gsap.Context | null = null

const nodes = [
  { x: 42, y: 390, r: 4 },
  { x: 116, y: 314, r: 5 },
  { x: 170, y: 230, r: 4 },
  { x: 202, y: 366, r: 4 },
  { x: 286, y: 274, r: 5 },
  { x: 348, y: 184, r: 4 },
  { x: 372, y: 350, r: 4 },
  { x: 470, y: 292, r: 5 },
  { x: 532, y: 220, r: 4 },
  { x: 554, y: 372, r: 4 },
  { x: 648, y: 318, r: 5 },
  { x: 730, y: 236, r: 4 },
  { x: 776, y: 354, r: 4 },
]

onMounted(() => {
  if (!root.value || !globe.value) return

  const shouldSkipAnimation = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || window.matchMedia('(max-width: 860px)').matches
  if (shouldSkipAnimation) return

  animationContext = gsap.context(() => {
    gsap.fromTo(
      root.value,
      { autoAlpha: 0, scale: 0.86 },
      { autoAlpha: 1, scale: 1, duration: 1.35, ease: 'power3.out' },
    )

    gsap.to(globe.value, {
      rotation: 360,
      transformOrigin: '248px 310px',
      duration: 48,
      repeat: -1,
      ease: 'none',
    })

    gsap.to('.network-node', {
      scale: 1.75,
      opacity: 0.36,
      transformOrigin: 'center',
      duration: 2.4,
      repeat: -1,
      yoyo: true,
      stagger: { each: 0.24, from: 'random' },
      ease: 'sine.inOut',
    })

    gsap.to('.flow-line', {
      strokeDashoffset: -124,
      duration: 7,
      repeat: -1,
      ease: 'none',
    })
  }, root.value)
})

onBeforeUnmount(() => animationContext?.revert())
</script>

<style scoped>
.legal-globe {
  width: min(760px, 72vw);
  aspect-ratio: 820 / 520;
  transform-origin: 22% 64%;
}

svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.globe-body {
  transform-box: view-box;
}

.connection-line,
.flow-line {
  fill: none;
  stroke: #8EB8F8;
  stroke-width: 1.25;
  stroke-linecap: round;
}

.connection-line { opacity: 0.34; }
.connection-line-soft { opacity: 0.18; }

.flow-line {
  opacity: 0.52;
  stroke: #2563EB;
  stroke-dasharray: 5 13 24 18;
  stroke-width: 1.6;
}

.flow-line-delay {
  opacity: 0.3;
  stroke-dasharray: 3 19 30 24;
}

.land-mass {
  fill: rgba(37, 99, 235, 0.08);
  stroke-width: 1.4;
}

.land-mass-soft {
  fill: rgba(37, 99, 235, 0.045);
}

.network-node {
  fill: #2563EB;
  opacity: 0.72;
  transform-box: fill-box;
}

@media (max-width: 980px) {
  .legal-globe {
    width: min(620px, 86vw);
  }
}
</style>

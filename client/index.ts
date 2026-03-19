import { Context } from '@koishijs/client'
import { computed, defineComponent, inject, onBeforeUnmount, onMounted, type ComputedRef, watch, h } from 'vue'

type NavSection = {
  key: string
  title: string
}

type NavGroup = {
  title: string
  sections: NavSection[]
}

const PLUGIN_NAMES = new Set([
  'social-media-parser',
  'koishi-plugin-social-media-parser',
])

function isSocialMediaParserPluginName(name: string | undefined): boolean {
  if (!name) return false
  if (PLUGIN_NAMES.has(name)) return true
  for (const pluginName of PLUGIN_NAMES) {
    if (name.startsWith(`${pluginName}:`)) return true
  }
  return false
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: '基础',
    sections: [
      { key: 'network-media', title: '网络与媒体设置' },
      { key: 'network', title: '网络设置' },
      { key: 'media', title: '媒体与发送设置' },
    ],
  },
  {
    title: '平台',
    sections: [
      { key: 'platforms', title: '平台设置' },
      { key: 'douyin', title: '抖音解析设置' },
      { key: 'xhs', title: '小红书解析设置' },
      { key: 'bili', title: 'Bilibili 解析设置' },
      { key: 'twitter', title: 'Twitter/X 解析设置' },
      { key: 'twitter-grok', title: 'Twitter/X Grok 设置' },
      { key: 'twitter-routing', title: 'Twitter/X 路由优先级设置' },
      { key: 'twitter-translation', title: 'Twitter/X 翻译设置' },
    ],
  },
  {
    title: '自动、转发与工具',
    sections: [
      { key: 'auto-forward', title: '自动解析与转发设置' },
      { key: 'auto-parse', title: '自动解析设置' },
      { key: 'forward', title: '转发消息设置' },
      { key: 'tool', title: 'ChatLuna 工具设置' },
      { key: 'debug', title: '调试设置' },
    ],
  },
]

const NAV_SECTIONS: NavSection[] = NAV_GROUPS.flatMap((group) => group.sections)

const SECTION_TITLE_ALIASES: Record<string, string[]> = {
  'network-media': ['网络与媒体设置'],
  network: ['网络设置'],
  media: ['媒体与发送设置'],
  platforms: ['平台设置', '平台解析设置'],
  douyin: ['抖音解析设置'],
  xhs: ['小红书解析设置'],
  bili: ['Bilibili 解析设置', '哔哩哔哩'],
  twitter: ['Twitter/X 解析设置', 'Twitter'],
  'twitter-grok': ['Twitter/X Grok 设置', 'Grok 设置'],
  'twitter-routing': ['Twitter/X 路由优先级设置', '路由优先级设置'],
  'twitter-translation': ['Twitter/X 翻译设置', '翻译设置'],
  'auto-forward': ['自动解析与转发设置'],
  forward: ['转发消息设置'],
  'auto-parse': ['自动解析设置'],
  tool: ['ChatLuna 工具设置', '工具设置'],
  debug: ['调试设置'],
}

const STYLE_ID = 'social-media-parser-nav-style'

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.social-media-parser-nav {
  position: absolute;
  z-index: 1000;
  width: 200px;
  max-width: 90vw;
  max-height: 70vh;
  background: var(--k-card-bg);
  border-radius: 8px;
  box-shadow: var(--k-card-shadow);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--k-card-border);
  user-select: none;
  overflow: hidden;
  transition: box-shadow 0.3s ease;
}
@media (max-width: 768px) {
  .social-media-parser-nav { width: 160px; max-height: 50vh; }
}
.social-media-parser-nav:hover {
  box-shadow: var(--k-card-shadow-hover, 0 4px 16px rgba(0,0,0,.15));
}
.social-media-parser-nav-header {
  padding: 4px 8px;
  border-bottom: 1px solid var(--k-color-divider, #ebeef5);
  background-color: var(--k-hover-bg);
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: move;
  transition: background-color 0.2s;
}
.social-media-parser-nav-header:hover {
  background-color: var(--k-activity-bg);
}
.social-media-parser-nav-handle {
  color: var(--k-text-light);
  cursor: grab;
  transition: color 0.2s;
}
.social-media-parser-nav-handle:active {
  cursor: grabbing;
  color: var(--k-color-primary);
}
.social-media-parser-nav-toggle {
  border: none;
  background: transparent;
  color: var(--k-text-light);
  cursor: pointer;
  padding: 0;
  font-size: 14px;
  line-height: 1;
  display: flex;
  align-items: center;
  transition: transform 0.3s ease, color 0.2s;
}
.social-media-parser-nav-toggle:hover {
  color: var(--k-text-active);
}
.social-media-parser-nav-body {
  overflow-y: auto;
  padding: 4px 0;
  transition: max-height 0.3s ease, opacity 0.3s ease;
  opacity: 1;
}
.social-media-parser-nav-body::-webkit-scrollbar { width: 6px; }
.social-media-parser-nav-body::-webkit-scrollbar-thumb { background: var(--k-scroll-thumb); border-radius: 3px; }
.social-media-parser-nav-body::-webkit-scrollbar-track { background: transparent; }
.social-media-parser-nav.collapsed .social-media-parser-nav-body {
  max-height: 0;
  padding: 0;
  opacity: 0;
  overflow: hidden;
}
.social-media-parser-nav.collapsed .social-media-parser-nav-toggle {
  transform: rotate(-90deg);
}
.social-media-parser-nav.collapsed .social-media-parser-nav-header {
  border-bottom: none;
}
.social-media-parser-nav-section {
  margin-bottom: 4px;
}
.social-media-parser-nav-section-title {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--k-text-light);
  background-color: var(--k-bg-light);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.social-media-parser-nav-item {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--k-text);
  text-align: left;
  padding: 5px 12px 5px 20px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.5;
  transition: background-color 0.15s, color 0.15s;
}
.social-media-parser-nav-item:hover {
  background-color: var(--k-hover-bg);
  color: var(--k-text-active);
}
.social-media-parser-nav-item.active {
  color: var(--k-color-primary);
  background-color: var(--k-hover-bg);
}
`
  document.head.appendChild(style)
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, '').trim()
}

function getSectionNodes() {
  return Array.from(document.querySelectorAll<HTMLElement>(
    '.k-schema-section-title, .k-schema-header, h2.k-schema-header'
  ))
}

function findHeaderBySection(section: NavSection) {
  const targets = [section.title, ...(SECTION_TITLE_ALIASES[section.key] || [])]
    .map((item) => normalizeText(item))
    .filter(Boolean)
  const headers = getSectionNodes()

  for (const header of headers) {
    const text = normalizeText(header.textContent || '')
    if (!text) continue
    if (targets.some((target) => text === target)) return header
  }

  for (const header of headers) {
    const text = normalizeText(header.textContent || '')
    if (!text) continue
    if (targets.some((target) => text.includes(target))) return header
  }
  return null
}

function matchSectionByHeaderText(text: string): NavSection | undefined {
  const normalized = normalizeText(text)
  let bestSection: NavSection | undefined
  let bestScore = 0

  for (const section of NAV_SECTIONS) {
    const candidates = [section.title, ...(SECTION_TITLE_ALIASES[section.key] || [])]
      .map((item) => normalizeText(item))
      .filter(Boolean)
    for (const candidate of candidates) {
      let score = 0
      if (normalized === candidate) {
        score = 200 + candidate.length
      } else if (normalized.includes(candidate)) {
        score = 100 + candidate.length
      }

      if (score > bestScore) {
        bestScore = score
        bestSection = section
      }
    }
  }

  return bestSection
}

function mountFloatingNav() {
  ensureStyle()

  const existing = document.querySelector<HTMLElement>('.social-media-parser-nav')
  existing?.remove()

  const root = document.createElement('div')
  root.className = 'social-media-parser-nav'
  root.innerHTML = `
<div class="social-media-parser-nav-header">
  <span class="social-media-parser-nav-handle">⋮⋮</span>
  <button class="social-media-parser-nav-toggle" type="button">−</button>
</div>
<div class="social-media-parser-nav-body"></div>
`
  document.body.appendChild(root)

  root.style.top = '260px'
  root.style.right = '60px'

  const body = root.querySelector<HTMLElement>('.social-media-parser-nav-body')!
  const toggle = root.querySelector<HTMLButtonElement>('.social-media-parser-nav-toggle')!
  const header = root.querySelector<HTMLElement>('.social-media-parser-nav-header')!

  const itemMap = new Map<string, HTMLButtonElement>()
  for (const group of NAV_GROUPS) {
    const sectionEl = document.createElement('div')
    sectionEl.className = 'social-media-parser-nav-section'

    const sectionTitle = document.createElement('div')
    sectionTitle.className = 'social-media-parser-nav-section-title'
    sectionTitle.textContent = group.title
    sectionEl.appendChild(sectionTitle)

    for (const section of group.sections) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'social-media-parser-nav-item'
      button.textContent = section.title
      button.addEventListener('click', () => {
        const target = findHeaderBySection(section)
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      })
      sectionEl.appendChild(button)
      itemMap.set(section.key, button)
    }
    body.appendChild(sectionEl)
  }

  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    const collapsed = root.classList.toggle('collapsed')
    toggle.textContent = collapsed ? '+' : '−'
  })

  let dragStartX = 0
  let dragStartY = 0
  let startRight = 0
  let startTop = 0

  header.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('.social-media-parser-nav-toggle')) return
    event.preventDefault()
    header.setPointerCapture(event.pointerId)
    dragStartX = event.clientX
    dragStartY = event.clientY
    startRight = parseFloat(root.style.right || '60')
    startTop = parseFloat(root.style.top || '260')
  })

  header.addEventListener('pointermove', (event) => {
    if (!header.hasPointerCapture(event.pointerId)) return
    const dx = event.clientX - dragStartX
    const dy = event.clientY - dragStartY
    root.style.top = `${Math.max(0, startTop + dy)}px`
    root.style.right = `${Math.max(0, startRight - dx)}px`
  })

  const onPointerEnd = (event: PointerEvent) => {
    if (header.hasPointerCapture(event.pointerId)) {
      header.releasePointerCapture(event.pointerId)
    }
  }
  header.addEventListener('pointerup', onPointerEnd)
  header.addEventListener('pointercancel', onPointerEnd)

  let observer: IntersectionObserver | null = null
  const refreshActive = () => {
    observer?.disconnect()
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const text = (entry.target.textContent || '').trim()
        const section = matchSectionByHeaderText(text)
        if (!section) continue
        for (const item of itemMap.values()) item.classList.remove('active')
        itemMap.get(section.key)?.classList.add('active')
        break
      }
    }, {
      root: null,
      rootMargin: '-20% 0px -60% 0px',
      threshold: 0,
    })

    const headers = getSectionNodes()
    for (const node of headers) {
      const text = node.textContent || ''
      if (matchSectionByHeaderText(text)) {
        observer.observe(node)
      }
    }
  }

  const mutationObserver = new MutationObserver(() => {
    window.setTimeout(refreshActive, 200)
  })
  mutationObserver.observe(document.body, { childList: true, subtree: true })

  window.setTimeout(refreshActive, 300)

  return () => {
    observer?.disconnect()
    mutationObserver.disconnect()
    root.remove()
  }
}

const SocialMediaParserDetailsLoader = defineComponent({
  name: 'SocialMediaParserDetailsLoader',
  setup() {
    const pluginName = inject<ComputedRef<string>>('plugin:name')
    const isOwn = computed(() => {
      const current = pluginName?.value
      return isSocialMediaParserPluginName(current)
    })

    let dispose: (() => void) | null = null

    const tryMount = () => {
      dispose?.()
      dispose = null
      if (!isOwn.value) return
      dispose = mountFloatingNav()
    }

    onMounted(tryMount)
    watch(isOwn, tryMount)
    onBeforeUnmount(() => dispose?.())
    return () => h('div', { style: { display: 'none' } })
  },
})

export default (ctx: Context) => {
  ctx.slot({
    type: 'plugin-details',
    component: SocialMediaParserDetailsLoader,
    order: -999,
  })
}

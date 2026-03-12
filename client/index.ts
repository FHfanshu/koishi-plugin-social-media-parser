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
    title: '自动与转发',
    sections: [
      { key: 'auto-forward', title: '自动解析与转发设置' },
      { key: 'auto-parse', title: '自动解析设置' },
      { key: 'forward', title: '转发消息设置' },
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
  debug: ['调试设置'],
}

const STYLE_ID = 'social-media-parser-nav-style'

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.social-media-parser-nav {
  position: fixed;
  top: 260px;
  right: 60px;
  z-index: 1000;
  width: 150px;
  max-width: 90vw;
  user-select: none;
}
.social-media-parser-nav-header {
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--k-color-border, #4b5563);
  background: color-mix(in srgb, var(--k-color-bg, #1f2937) 94%, white);
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: move;
  touch-action: none;
}
.social-media-parser-nav-handle {
  color: var(--k-text-light, #9ca3af);
  font-size: 14px;
  line-height: 1;
}
.social-media-parser-nav-toggle {
  border: none;
  background: transparent;
  color: var(--k-text-light, #9ca3af);
  cursor: pointer;
  padding: 0;
  font-size: 14px;
  line-height: 1;
}
.social-media-parser-nav-body {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.social-media-parser-nav.collapsed .social-media-parser-nav-body {
  display: none;
}
.social-media-parser-nav-item {
  border: none;
  background: transparent;
  color: var(--k-text, #d1d5db);
  text-align: left;
  padding: 6px 4px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1.4;
}
.social-media-parser-nav-item:hover {
  color: var(--k-color-primary, #4f7cff);
}
.social-media-parser-nav-item.active {
  color: var(--k-color-primary, #4f7cff);
}
.social-media-parser-nav-group {
  margin-top: 4px;
  padding: 6px 4px 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--k-text-light, #9ca3af);
  opacity: 0.9;
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
  <button class="social-media-parser-nav-toggle" type="button">⌄</button>
</div>
<div class="social-media-parser-nav-body"></div>
`
  document.body.appendChild(root)

  const body = root.querySelector<HTMLElement>('.social-media-parser-nav-body')!
  const toggle = root.querySelector<HTMLButtonElement>('.social-media-parser-nav-toggle')!
  const header = root.querySelector<HTMLElement>('.social-media-parser-nav-header')!

  const itemMap = new Map<string, HTMLButtonElement>()
  for (const group of NAV_GROUPS) {
    const groupTitle = document.createElement('div')
    groupTitle.className = 'social-media-parser-nav-group'
    groupTitle.textContent = group.title
    body.appendChild(groupTitle)

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
      body.appendChild(button)
      itemMap.set(section.key, button)
    }
  }

  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    const collapsed = root.classList.toggle('collapsed')
    toggle.textContent = collapsed ? '⌃' : '⌄'
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
      return !!current && PLUGIN_NAMES.has(current)
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

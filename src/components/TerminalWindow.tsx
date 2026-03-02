import type { CSSProperties, ReactNode, RefObject } from 'react'

type TerminalWindowProps = {
  title: string
  subtitle?: string
  className?: string
  style?: CSSProperties
  headerRef?: RefObject<HTMLElement | null>
  bodyRef?: RefObject<HTMLDivElement | null>
  children: ReactNode
}

export function TerminalWindow({
  title,
  subtitle,
  className,
  style,
  headerRef,
  bodyRef,
  children,
}: TerminalWindowProps) {
  return (
    <section className={`terminal-window ${className ?? ''}`.trim()} style={style}>
      <header className="terminal-window__header" ref={headerRef}>
        <div className="traffic-lights" aria-hidden="true">
          <span className="traffic-light traffic-light--close" />
          <span className="traffic-light traffic-light--minimize" />
          <span className="traffic-light traffic-light--maximize" />
        </div>
        <div className="terminal-window__title-row">
          <p className="terminal-window__title">{title}</p>
          {subtitle ? <p className="terminal-window__subtitle">{subtitle}</p> : null}
        </div>
      </header>
      <div className="terminal-window__body" ref={bodyRef}>
        {children}
      </div>
    </section>
  )
}

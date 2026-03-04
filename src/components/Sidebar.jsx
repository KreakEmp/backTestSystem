const NAV = [
  { id: 'backtest',   label: 'Backtest',        icon: '📈' },
  { id: 'bulk',       label: 'Bulk Backtest',   icon: '📊' },
  { id: 'indicators', label: 'Indicator Chart', icon: '🕯️' },
  { id: 'settings',   label: 'Settings',        icon: '⚙️' },
]

export default function Sidebar({ activePage, onNavigate, collapsed, onToggleCollapse, mobileOpen, onClose }) {
  const cls = ['sidebar', collapsed && 'sidebar-collapsed', mobileOpen && 'sidebar-mobile-open']
    .filter(Boolean).join(' ')

  return (
    <>
      {mobileOpen && <div className="sidebar-overlay" onClick={onClose} />}

      <nav className={cls}>
        <div className="sidebar-logo">
          <div className="sidebar-logo-text">
            <h2>StockBT</h2>
            <p>NSE Backtester</p>
          </div>
          <button
            className="sidebar-collapse-btn"
            onClick={onToggleCollapse}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? '›' : '‹'}
          </button>
        </div>

        <ul className="sidebar-nav">
          {NAV.map(item => (
            <li key={item.id}>
              <button
                className={`nav-item${activePage === item.id ? ' active' : ''}`}
                onClick={() => { onNavigate(item.id); onClose?.() }}
                title={item.label}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </>
  )
}

const NAV = [
  { id: 'backtest',   label: 'Backtest',         icon: '📈' },
  { id: 'indicators', label: 'Indicator Chart',  icon: '🕯️' },
  { id: 'settings',   label: 'Settings',         icon: '⚙️' },
]

export default function Sidebar({ activePage, onNavigate }) {
  return (
    <nav className="sidebar">
      <div className="sidebar-logo">
        <h2>StockBT</h2>
        <p>NSE Backtester</p>
      </div>

      <ul className="sidebar-nav">
        {NAV.map(item => (
          <li key={item.id}>
            <button
              className={`nav-item ${activePage === item.id ? 'active' : ''}`}
              onClick={() => onNavigate(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

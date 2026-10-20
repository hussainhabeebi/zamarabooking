export default function SearchLoading() {
  return (
    <main className="page-container search-loading-page">
      <div className="loading-orbit" aria-hidden="true"><span>✈</span></div>
      <h1>Finding your best flights</h1>
      <p>Checking live fares, baggage and journey times…</p>
      <div className="loading-steps" aria-label="Searching live suppliers">
        <span className="done">Route checked</span><span className="active">Live fares</span><span>Best options</span>
      </div>
      <div className="fare-skeleton-list">
        {[0, 1, 2].map((i) => (
          <div className="fare-skeleton" key={i}>
            <div className="skeleton airline" />
            <div className="skeleton times" />
            <div className="skeleton details" />
            <div className="skeleton price" />
          </div>
        ))}
      </div>
      <p className="loading-note">Please keep this page open. Live supplier searches may take a few seconds.</p>
    </main>
  );
}

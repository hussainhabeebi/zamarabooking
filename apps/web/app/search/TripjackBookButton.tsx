"use client";

export default function TripjackBookButton({ fareId, supplier, fareData }: { fareId: string; supplier: string; fareData: unknown }) {
  function handleClick() {
    try { sessionStorage.setItem(`fare:${fareId}`, JSON.stringify(fareData)); } catch {}
    window.location.href = `/book?fareId=${encodeURIComponent(fareId)}&supplier=${encodeURIComponent(supplier)}`;
  }
  return (
    <button
      type="button"
      className="fare-card-book-btn"
      style={{ marginTop: 8, width: "100%", border: 0, cursor: "pointer", WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
      onClick={handleClick}
    >
      Book Now
    </button>
  );
}

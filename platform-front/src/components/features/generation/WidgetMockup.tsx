export function WidgetMockup() {
  return (
    <div className="bg-white rounded-xl overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
      <div className="bg-[#1a1a2e] px-3.5 py-2 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-[#e74c3c]" />
        <span className="w-2 h-2 rounded-full bg-[#f39c12]" />
        <span className="w-2 h-2 rounded-full bg-[#27ae60]" />
        <span className="ml-2 text-[10px] text-white/40 font-mono">
          demo-store.myshopify.com/products/blue-hoodie
        </span>
      </div>
      <div className="p-5 bg-gray-50">
        <div className="text-base font-bold text-[#1a1a2e] mb-1">Classic Blue Hoodie</div>
        <div className="text-xl font-extrabold text-[#1a1a2e] mb-4">$59.00</div>
        <div className="text-[11px] font-bold text-red-500 mb-2">✗ Out of Stock</div>
        <div className="bg-white border border-gray-200 rounded-[10px] p-4 mt-3">
          <div className="text-[13px] font-bold text-[#1a1a2e] mb-2">
            🔔 Notify Me When Available
          </div>
          <input
            readOnly
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs text-gray-600 mb-2.5 outline-none"
            placeholder="Enter your email..."
          />
          <button
            type="button"
            className="w-full py-2.5 bg-[#1a1a2e] text-white rounded-lg text-[13px] font-bold border-0 cursor-default"
          >
            Notify Me
          </button>
        </div>
      </div>
    </div>
  );
}

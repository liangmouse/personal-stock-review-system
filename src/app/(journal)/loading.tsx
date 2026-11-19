export default function JournalLoading() {
  return (
    <div aria-label="正在读取交易记录" className="loading-state" role="status">
      <span className="loading-line" />
      <span className="loading-line loading-line-short" />
    </div>
  );
}

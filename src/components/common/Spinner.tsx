export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function FullPageSpinner() {
  return (
    <div className="fullpage-center">
      <Spinner size={28} />
    </div>
  );
}

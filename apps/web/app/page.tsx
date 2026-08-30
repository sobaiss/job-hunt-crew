// Placeholder front door. The real Landing page / Dashboard redirect is built in
// a later foundation ticket; this only replaces the create-next-app boilerplate
// (which referenced the now-deleted template SVGs).
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="font-serif text-4xl font-semibold tracking-tight">
        Job Hunt Crew
      </h1>
      <p className="max-w-md text-muted">
        Match your CV against real job offers and see exactly where you stand.
      </p>
    </main>
  );
}

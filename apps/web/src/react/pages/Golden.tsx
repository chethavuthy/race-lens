/**
 * Parity gate. Dev builds only — the vite config strips public/golden from dist.
 *
 * The browser embedder must produce vectors matching the Python indexer's to
 * cosine >= 0.99, or every face search silently returns nothing. Silently is the
 * problem: nothing throws, results are simply empty, and the cause is a few
 * degrees of misalignment three layers down. This page runs the fixture and
 * prints the number.
 */
import { useEffect, useState } from 'react';
import { embedLargestFace, loadModels } from '@/lib/face';

export default function Golden() {
  const [cosine, setCosine] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const expected: number[] = (await (await fetch('/golden/golden.json')).json()).embedding;
        await loadModels();
        const blob = await (await fetch('/golden/test.jpg')).blob();
        const { vec } = await embedLargestFace(blob);
        let dot = 0;
        for (let i = 0; i < vec.length; i++) dot += vec[i] * expected[i];
        setCosine(dot);
      } catch (e) { setError((e as Error).message); }
    })();
  }, []);

  const pass = cosine !== null && cosine >= 0.99;
  return (
    <div className="py-10">
      <h1 className="mb-4 text-2xl font-bold tracking-tight">Golden parity</h1>
      {error ? (
        <p className="text-destructive">{error}</p>
      ) : cosine === null ? (
        <p className="text-muted-foreground">Running the fixture…</p>
      ) : (
        <p className={`tabular font-[family-name:var(--font-display)] text-4xl font-bold ${pass ? 'text-primary' : 'text-destructive'}`}>
          {cosine.toFixed(6)} {pass ? 'PASS' : 'FAIL'}
        </p>
      )}
      <p className="mt-3 max-w-lg text-sm text-muted-foreground">
        Browser embedding vs the indexer's reference vector. Must be at least
        0.990000 — below that, face search returns nothing and says nothing.
      </p>
    </div>
  );
}

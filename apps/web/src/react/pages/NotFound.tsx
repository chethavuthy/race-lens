import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="py-10">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">Page not found</h1>
      <p className="mb-6 text-muted-foreground">That link does not lead anywhere.</p>
      {/* Base UI polymorphism is `render`, not Radix's `asChild` — the two bases
          differ here and the registry ships whichever the project selected. */}
      <Button render={<Link to="/" />}>Back to events</Button>
    </div>
  );
}

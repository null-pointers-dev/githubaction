import { notFound } from "next/navigation";
import { requireUser } from "@/server/session";
import { getRunView } from "@/server/views";
import { RunView } from "@/components/RunView";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const view = await getRunView(id, user);
  if (!view) notFound();
  return (
    <main className="page">
      <RunView initial={view} />
    </main>
  );
}

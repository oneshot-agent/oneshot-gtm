import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client.ts";

/** Who to show: a prospect, or a queue row when the row has no prospect yet. */
export interface PersonKey {
  prospectId?: number | null;
  queueId?: number | null;
}

/** One cache entry per person, so every pane on a page shares one request. */
export function personKey({ prospectId, queueId }: PersonKey): Array<string | number> {
  return ["person", prospectId != null ? prospectId : `q${queueId}`];
}

/** `GET /api/person`, read-only: it never buys research. */
export function usePerson(key: PersonKey) {
  const { prospectId, queueId } = key;
  return useQuery({
    queryKey: personKey(key),
    queryFn: () =>
      prospectId != null ? api.person({ prospectId }) : api.person({ queueId: queueId as number }),
    enabled: prospectId != null || queueId != null,
    staleTime: 30_000,
  });
}

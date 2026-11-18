import { readWorkProjection } from "../../../../work/projection";
import { json } from "../../../utils/http";

/** The castle's view of the work store: read-only, bounded and sanitised. Needs no Mesh credential. */
export function handleWork(_req: Request): Response {
  return json(readWorkProjection());
}

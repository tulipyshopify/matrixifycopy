import type { Entity } from "../core/types";
import { productsEntity } from "./products";

/** All entities, in import order (dependencies first). */
export const ENTITIES: Entity[] = [productsEntity];

export function getEntity(key: string): Entity | undefined {
  return ENTITIES.find((e) => e.key === key);
}

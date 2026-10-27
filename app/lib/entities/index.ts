import type { Entity } from "../core/types";
import { productsEntity } from "./products";
import { customCollectionsEntity, smartCollectionsEntity } from "./collections";
import { customersEntity } from "./customers";
import { companiesEntity } from "./companies";
import { pagesEntity } from "./pages";
import { blogPostsEntity } from "./blog_posts";
import { redirectsEntity } from "./redirects";
import { filesEntity } from "./files";
import { metaobjectsEntity } from "./metaobjects";
import { menusEntity } from "./menus";
import { shopEntity } from "./shop";

/** All entities, in import order (dependencies first). */
export const ENTITIES: Entity[] = [
  productsEntity,
  smartCollectionsEntity,
  customCollectionsEntity,
  customersEntity,
  companiesEntity,
  filesEntity,
  metaobjectsEntity,
  pagesEntity,
  blogPostsEntity,
  redirectsEntity,
  menusEntity,
  shopEntity,
];

export function getEntity(key: string): Entity | undefined {
  return ENTITIES.find((e) => e.key === key);
}

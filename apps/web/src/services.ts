import { createAuth } from "@jomans-vault/auth";
import { createDb } from "@jomans-vault/db";

import { ENV } from "./env.server";

export const db = createDb(ENV);
export const auth = createAuth(ENV, db);

"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { FastApiCrmClient, unifiedFastapiCrmEnabled } from "@/server/fastapi-crm";
import { requirePermission } from "@/server/dal";
import { fastApiActorForStaff } from "@/server/fastapi-staff";

const packageId = z.string().min(1).max(32);
const slug = z.string().trim().min(2).max(120);
const name = z.string().trim().min(2).max(255);
const priceFrom = z.coerce.number().int().min(0).max(10_000_000);
const priceLabel = z.string().trim().min(1).max(64);
const guestCapacityLabel = z.string().trim().min(1).max(64);
const description = z.string().trim().min(10).max(5000);
const displayOrder = z.coerce.number().int().min(0).max(1000);
const packageFields = z.object({ name, slug, priceFrom, priceLabel, guestCapacityLabel, description, displayOrder });
const str = (formData: FormData, field: string) => String(formData.get(field) ?? "");

function readPackageFields(formData: FormData) {
  return packageFields.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    priceFrom: formData.get("priceFrom"),
    priceLabel: formData.get("priceLabel"),
    guestCapacityLabel: formData.get("guestCapacityLabel"),
    description: formData.get("description"),
    displayOrder: formData.get("displayOrder"),
  });
}

function result(code: string): never {
  redirect(`/catalog?notice=${code}`);
}

async function clientFor(user: Parameters<typeof fastApiActorForStaff>[0]) {
  const actor = await fastApiActorForStaff(user, { requestId: randomUUID() });
  return new FastApiCrmClient(actor);
}

export async function updateCatalogPackageAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("prices.manage");
  const id = packageId.safeParse(formData.get("packageId"));
  const input = readPackageFields(formData);
  if (!id.success || !input.success) result("invalid");
  if (!unifiedFastapiCrmEnabled()) result("unavailable");

  let client: FastApiCrmClient;
  let branches: Awaited<ReturnType<FastApiCrmClient["getBookingCatalog"]>>["branches"];
  try {
    client = await clientFor(user);
    branches = (await client.getBookingCatalog()).branches;
  } catch {
    result("failed");
  }
  if (branches.length !== 1 || !branches[0]) result("branch");
  const branchId = branches[0].id;
  let item: Awaited<ReturnType<FastApiCrmClient["getAdminBirthdayPackage"]>>;
  try {
    item = await client.getAdminBirthdayPackage(id.data);
  } catch {
    result("failed");
  }
  if (item.branchId !== branchId) result("branch");
  try {
    await client.updateAdminBirthdayPackage(id.data, {
      name: input.data.name,
      slug: input.data.slug,
      price_from: input.data.priceFrom,
      price_label: input.data.priceLabel,
      guest_capacity_label: input.data.guestCapacityLabel,
      description: input.data.description,
      display_order: input.data.displayOrder,
      is_active: str(formData, "isActive") === "on",
      is_featured: str(formData, "isFeatured") === "on",
    });
  } catch {
    result("failed");
  }
  result("saved");
}

export async function createCatalogPackageAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("prices.manage");
  const input = readPackageFields(formData);
  if (!input.success) result("invalid");
  if (!unifiedFastapiCrmEnabled()) result("unavailable");

  let client: FastApiCrmClient;
  let branches: Awaited<ReturnType<FastApiCrmClient["getBookingCatalog"]>>["branches"];
  try {
    client = await clientFor(user);
    branches = (await client.getBookingCatalog()).branches;
  } catch {
    result("failed");
  }
  if (branches.length !== 1 || !branches[0]) result("branch");
  const branchId = branches[0].id;
  try {
    await client.createAdminBirthdayPackage({
      branch_id: branchId,
      name: input.data.name,
      slug: input.data.slug,
      price_from: input.data.priceFrom,
      price_label: input.data.priceLabel,
      guest_capacity_label: input.data.guestCapacityLabel,
      description: input.data.description,
      display_order: input.data.displayOrder,
      is_featured: str(formData, "isFeatured") === "on",
      is_active: str(formData, "isActive") === "on",
    });
  } catch {
    result("failed");
  }
  result("created");
}

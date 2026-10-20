import { createDb } from "./client.js";
import { tenants, users, tenantSupplierConfigs, markupRules } from "./schema/index.js";

const db = createDb(process.env.DATABASE_URL!);

async function seed() {
  console.log("🌱 Seeding ZamraBooking platform...");

  // Platform tenant (Zamra Travels itself)
  const [platformTenant] = await db
    .insert(tenants)
    .values({
      name:           "Zamra Travels",
      slug:           "poomas",
      status:         "ACTIVE",
      plan:           "ENTERPRISE",
      region:         "INDIA",
      defaultCurrency: "INR",
      defaultLanguage: "en",
      companyName:    "Zamra Travels",
      tagline:        "Your Trusted Travel Partner",
      primaryColor:   "#0D4B96",
      secondaryColor: "#1E88D9",
      accentColor:    "#66B8E8",
      showPoweredBy:  false,
      supportEmail:   "support@zamrabooking.com",
      allowB2C:       true,
      allowB2B:       true,
      allowWhatsApp:  true,
      isSetupComplete: true,
      onboardingStep:  5,
    })
    .onConflictDoNothing({ target: tenants.slug })
    .returning();

  if (!platformTenant) {
    console.log("Platform tenant already exists, skipping seed.");
    return;
  }

  console.log(`✅ Platform tenant created: ${platformTenant.id}`);

  // Default supplier configs (using platform Riya & Tripjack contracts)
  await db.insert(tenantSupplierConfigs).values([
    {
      tenantId:   platformTenant.id,
      supplier:   "RIYA",
      isEnabled:  true,
      priority:   1,
      credentials: null,  // null = use platform env vars
      timeoutMs:  15000,
      maxRetries: 2,
    },
    {
      tenantId:   platformTenant.id,
      supplier:   "TRIPJACK",
      isEnabled:  true,
      priority:   2,
      credentials: null,
      timeoutMs:  15000,
      maxRetries: 2,
    },
    {
      tenantId:   platformTenant.id,
      supplier:   "GOOGLE_SERP",
      isEnabled:  true,
      priority:   3,
      credentials: null,
      timeoutMs:  10000,
      maxRetries: 1,
    },
  ]);

  // Default markup rule (platform-wide, all routes, all airlines)
  await db.insert(markupRules).values({
    tenantId:    platformTenant.id,
    name:        "Platform Default Markup",
    isDefault:   true,
    markupType:  "FLAT",
    markupValue: "250",  // ₹250 default platform markup
    isActive:    true,
    priority:    0,
  });

  // Super-admin user
  await db.insert(users).values({
    tenantId:      platformTenant.id,
    email:         process.env.PLATFORM_ADMIN_EMAIL ?? "admin@zamrabooking.com",
    name:          "ZamraBooking Admin",
    role:          "SUPER_ADMIN",
    emailVerified: true,
    isActive:      true,
  });

  console.log("✅ Seed complete.");
}

seed().catch((e) => {
  console.error("❌ Seed failed:", e);
  process.exit(1);
});

import type { BundleType, CategoryOption } from "../../../../packages/shared/types";

export const BUNDLE_TEMPLATES: Record<BundleType, CategoryOption[]> = {
  renovation: [
    { category: "Materials", subcategories: ["Lumber", "Hardware", "Paint", "Plumbing", "Electrical", "Tile/Stone"] },
    { category: "Labor",     subcategories: ["Contractor", "Subcontractor", "Permit"] },
    { category: "Tools",     subcategories: ["Rental", "Purchase"] },
    { category: "Fixtures",  subcategories: ["Lighting", "Appliances", "Cabinetry"] },
  ],
  trip: [
    { category: "Travel",     subcategories: ["Flights", "Trains", "Rideshare", "Rental car", "Fuel"] },
    { category: "Lodging",    subcategories: ["Hotel", "Airbnb"] },
    { category: "Food",       subcategories: ["Restaurant", "Groceries", "Coffee"] },
    { category: "Activities", subcategories: ["Tickets", "Tours", "Gear rental"] },
  ],
  project: [
    { category: "Materials", subcategories: [] },
    { category: "Services",  subcategories: [] },
    { category: "Tools",     subcategories: [] },
  ],
};

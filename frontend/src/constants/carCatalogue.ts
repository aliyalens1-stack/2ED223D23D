// Catalogue of car brands and their popular models for the EU market.
// Used by BrandPickerModal / ModelPickerModal in /auto-request/create.
// Frontend-only static list — can be replaced with a backend endpoint later
// without changing the consumer components (they accept brand/model as strings).

export type CarBrand = {
  id: string;       // lowercase id, used as key
  name: string;     // display name
  country?: string; // optional flag/region hint
};

export const CAR_BRANDS: CarBrand[] = [
  { id: 'audi', name: 'Audi', country: 'DE' },
  { id: 'bmw', name: 'BMW', country: 'DE' },
  { id: 'mercedes-benz', name: 'Mercedes-Benz', country: 'DE' },
  { id: 'volkswagen', name: 'Volkswagen', country: 'DE' },
  { id: 'porsche', name: 'Porsche', country: 'DE' },
  { id: 'opel', name: 'Opel', country: 'DE' },
  { id: 'mini', name: 'Mini', country: 'DE' },
  { id: 'smart', name: 'Smart', country: 'DE' },
  { id: 'volvo', name: 'Volvo', country: 'SE' },
  { id: 'skoda', name: 'Škoda', country: 'CZ' },
  { id: 'seat', name: 'SEAT', country: 'ES' },
  { id: 'cupra', name: 'CUPRA', country: 'ES' },
  { id: 'renault', name: 'Renault', country: 'FR' },
  { id: 'peugeot', name: 'Peugeot', country: 'FR' },
  { id: 'citroen', name: 'Citroën', country: 'FR' },
  { id: 'ds', name: 'DS Automobiles', country: 'FR' },
  { id: 'dacia', name: 'Dacia', country: 'RO' },
  { id: 'fiat', name: 'Fiat', country: 'IT' },
  { id: 'alfa-romeo', name: 'Alfa Romeo', country: 'IT' },
  { id: 'lancia', name: 'Lancia', country: 'IT' },
  { id: 'maserati', name: 'Maserati', country: 'IT' },
  { id: 'ferrari', name: 'Ferrari', country: 'IT' },
  { id: 'lamborghini', name: 'Lamborghini', country: 'IT' },
  { id: 'jaguar', name: 'Jaguar', country: 'GB' },
  { id: 'land-rover', name: 'Land Rover', country: 'GB' },
  { id: 'mclaren', name: 'McLaren', country: 'GB' },
  { id: 'bentley', name: 'Bentley', country: 'GB' },
  { id: 'rolls-royce', name: 'Rolls-Royce', country: 'GB' },
  { id: 'aston-martin', name: 'Aston Martin', country: 'GB' },
  { id: 'lotus', name: 'Lotus', country: 'GB' },
  { id: 'toyota', name: 'Toyota', country: 'JP' },
  { id: 'lexus', name: 'Lexus', country: 'JP' },
  { id: 'honda', name: 'Honda', country: 'JP' },
  { id: 'mazda', name: 'Mazda', country: 'JP' },
  { id: 'nissan', name: 'Nissan', country: 'JP' },
  { id: 'infiniti', name: 'Infiniti', country: 'JP' },
  { id: 'subaru', name: 'Subaru', country: 'JP' },
  { id: 'mitsubishi', name: 'Mitsubishi', country: 'JP' },
  { id: 'suzuki', name: 'Suzuki', country: 'JP' },
  { id: 'hyundai', name: 'Hyundai', country: 'KR' },
  { id: 'kia', name: 'Kia', country: 'KR' },
  { id: 'genesis', name: 'Genesis', country: 'KR' },
  { id: 'ssangyong', name: 'SsangYong', country: 'KR' },
  { id: 'ford', name: 'Ford', country: 'US' },
  { id: 'chevrolet', name: 'Chevrolet', country: 'US' },
  { id: 'cadillac', name: 'Cadillac', country: 'US' },
  { id: 'tesla', name: 'Tesla', country: 'US' },
  { id: 'jeep', name: 'Jeep', country: 'US' },
  { id: 'chrysler', name: 'Chrysler', country: 'US' },
  { id: 'dodge', name: 'Dodge', country: 'US' },
  { id: 'gmc', name: 'GMC', country: 'US' },
  { id: 'lincoln', name: 'Lincoln', country: 'US' },
  { id: 'byd', name: 'BYD', country: 'CN' },
  { id: 'mg', name: 'MG', country: 'CN' },
  { id: 'nio', name: 'NIO', country: 'CN' },
  { id: 'lynk-co', name: 'Lynk & Co', country: 'CN' },
  { id: 'polestar', name: 'Polestar', country: 'SE' },
  { id: 'rivian', name: 'Rivian', country: 'US' },
  { id: 'lucid', name: 'Lucid', country: 'US' },
];

// Models per brand. Keep top-selling models for the EU market — extend over time.
// Lookup via CAR_MODELS[brandId] ?? [].
export const CAR_MODELS: Record<string, string[]> = {
  audi: ['A1', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'Q2', 'Q3', 'Q4 e-tron', 'Q5', 'Q7', 'Q8', 'e-tron GT', 'TT', 'R8', 'RS3', 'RS4', 'RS6', 'RS7', 'S3', 'S4', 'S5'],
  bmw: ['1 Series', '2 Series', '3 Series', '4 Series', '5 Series', '6 Series', '7 Series', '8 Series', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'Z4', 'i3', 'i4', 'i5', 'i7', 'iX', 'iX1', 'iX3', 'M2', 'M3', 'M4', 'M5', 'M8', 'XM'],
  'mercedes-benz': ['A-Class', 'B-Class', 'C-Class', 'CLA', 'CLE', 'CLS', 'E-Class', 'S-Class', 'GLA', 'GLB', 'GLC', 'GLE', 'GLS', 'G-Class', 'EQA', 'EQB', 'EQC', 'EQE', 'EQS', 'EQV', 'V-Class', 'Vito', 'AMG GT', 'SL', 'SLC'],
  volkswagen: ['Polo', 'Golf', 'Jetta', 'Passat', 'Arteon', 'T-Cross', 'T-Roc', 'Tiguan', 'Touareg', 'Touran', 'Sharan', 'Caddy', 'Multivan', 'Transporter', 'ID.3', 'ID.4', 'ID.5', 'ID.7', 'ID. Buzz', 'up!', 'Caravelle'],
  porsche: ['911', 'Taycan', 'Panamera', 'Cayenne', 'Macan', 'Boxster', 'Cayman', '718'],
  opel: ['Corsa', 'Astra', 'Insignia', 'Mokka', 'Crossland', 'Grandland', 'Combo', 'Vivaro', 'Movano', 'Zafira', 'Adam', 'Karl'],
  mini: ['Cooper', 'Cooper S', 'Cooper SE', 'Clubman', 'Countryman', 'Convertible', 'John Cooper Works'],
  smart: ['fortwo', 'forfour', '#1', '#3'],
  volvo: ['XC40', 'XC60', 'XC90', 'V60', 'V90', 'S60', 'S90', 'EX30', 'EX90', 'C40'],
  skoda: ['Fabia', 'Scala', 'Octavia', 'Superb', 'Kamiq', 'Karoq', 'Kodiaq', 'Enyaq', 'Citigo', 'Rapid'],
  seat: ['Ibiza', 'Leon', 'Arona', 'Ateca', 'Tarraco', 'Alhambra', 'Mii'],
  cupra: ['Born', 'Formentor', 'Leon', 'Ateca', 'Tavascan'],
  renault: ['Clio', 'Captur', 'Megane', 'Megane E-Tech', 'Scenic', 'Kadjar', 'Arkana', 'Austral', 'Espace', 'Talisman', 'Twingo', 'Zoe', 'Kangoo', 'Trafic', 'Master'],
  peugeot: ['208', '2008', '308', '3008', '408', '508', '5008', '208 e', 'e-208', 'e-2008', 'Rifter', 'Partner', 'Boxer', 'Expert'],
  citroen: ['C1', 'C3', 'C4', 'C4 X', 'C5 X', 'C5 Aircross', 'Berlingo', 'Spacetourer', 'Jumpy', 'Jumper', 'ë-C4', 'ë-Berlingo'],
  ds: ['DS 3', 'DS 4', 'DS 7', 'DS 9'],
  dacia: ['Sandero', 'Logan', 'Duster', 'Jogger', 'Spring', 'Lodgy'],
  fiat: ['500', '500e', '500X', '500L', 'Panda', 'Tipo', 'Punto', 'Doblo', 'Ducato', '600'],
  'alfa-romeo': ['Giulia', 'Stelvio', 'Tonale', 'Giulietta', '4C', 'Mito'],
  lancia: ['Ypsilon', 'Delta'],
  maserati: ['Ghibli', 'Quattroporte', 'Levante', 'Grecale', 'MC20', 'GranTurismo'],
  ferrari: ['Roma', 'Portofino', '296 GTB', 'F8 Tributo', 'SF90 Stradale', 'Purosangue', '812 Superfast'],
  lamborghini: ['Huracán', 'Aventador', 'Urus', 'Revuelto'],
  jaguar: ['XE', 'XF', 'F-Pace', 'E-Pace', 'I-Pace', 'F-Type'],
  'land-rover': ['Defender', 'Discovery', 'Discovery Sport', 'Range Rover', 'Range Rover Sport', 'Range Rover Velar', 'Range Rover Evoque'],
  mclaren: ['720S', '750S', 'Artura', 'GT', '765LT'],
  bentley: ['Continental GT', 'Flying Spur', 'Bentayga'],
  'rolls-royce': ['Phantom', 'Ghost', 'Wraith', 'Cullinan', 'Spectre'],
  'aston-martin': ['Vantage', 'DB11', 'DB12', 'DBX', 'DBS'],
  lotus: ['Emira', 'Eletre', 'Evija'],
  toyota: ['Yaris', 'Yaris Cross', 'Corolla', 'Corolla Cross', 'C-HR', 'RAV4', 'Highlander', 'Camry', 'Avensis', 'Auris', 'Prius', 'bZ4X', 'Land Cruiser', 'Hilux', 'Proace', 'Aygo', 'Aygo X', 'Mirai', 'GR Yaris', 'GR86', 'Supra'],
  lexus: ['CT', 'IS', 'ES', 'LS', 'NX', 'RX', 'UX', 'GX', 'LX', 'RZ', 'RC', 'LC'],
  honda: ['Jazz', 'Civic', 'CR-V', 'HR-V', 'e:Ny1', 'Accord', 'NSX'],
  mazda: ['Mazda2', 'Mazda3', 'Mazda6', 'CX-3', 'CX-30', 'CX-5', 'CX-60', 'CX-90', 'MX-30', 'MX-5'],
  nissan: ['Micra', 'Juke', 'Qashqai', 'X-Trail', 'Leaf', 'Ariya', 'Note', 'Pulsar', 'Navara', 'Townstar', 'Primastar', 'Interstar', '350Z', '370Z', 'GT-R'],
  infiniti: ['Q30', 'Q50', 'Q60', 'QX30', 'QX50', 'QX60', 'QX70', 'QX80'],
  subaru: ['Impreza', 'Forester', 'Outback', 'XV', 'Crosstrek', 'Solterra', 'BRZ', 'WRX'],
  mitsubishi: ['ASX', 'Eclipse Cross', 'Outlander', 'Outlander PHEV', 'Space Star', 'L200', 'Pajero'],
  suzuki: ['Swift', 'Ignis', 'Vitara', 'S-Cross', 'Jimny', 'Across', 'Swace', 'Baleno'],
  hyundai: ['i10', 'i20', 'i30', 'Bayon', 'Kona', 'Tucson', 'Santa Fe', 'IONIQ 5', 'IONIQ 6', 'IONIQ', 'Nexo', 'Staria', 'i40'],
  kia: ['Picanto', 'Rio', 'Stonic', 'Ceed', 'XCeed', 'ProCeed', 'Niro', 'Sportage', 'Sorento', 'EV3', 'EV6', 'EV9', 'Soul', 'Stinger'],
  genesis: ['G70', 'G80', 'G90', 'GV60', 'GV70', 'GV80'],
  ssangyong: ['Tivoli', 'Korando', 'Rexton', 'Musso', 'Torres'],
  ford: ['Fiesta', 'Focus', 'Mondeo', 'Puma', 'EcoSport', 'Kuga', 'Escape', 'Edge', 'Explorer', 'Mustang', 'Mustang Mach-E', 'Tourneo', 'Transit', 'Ranger', 'F-150'],
  chevrolet: ['Spark', 'Aveo', 'Cruze', 'Camaro', 'Corvette', 'Trax', 'Captiva', 'Equinox', 'Tahoe', 'Suburban', 'Silverado'],
  cadillac: ['CT4', 'CT5', 'CT6', 'XT4', 'XT5', 'XT6', 'Escalade', 'Lyriq'],
  tesla: ['Model 3', 'Model Y', 'Model S', 'Model X', 'Cybertruck', 'Roadster'],
  jeep: ['Renegade', 'Compass', 'Cherokee', 'Grand Cherokee', 'Wrangler', 'Gladiator', 'Avenger'],
  chrysler: ['300', 'Pacifica', 'Voyager'],
  dodge: ['Charger', 'Challenger', 'Durango', 'Hornet'],
  gmc: ['Sierra', 'Yukon', 'Acadia', 'Terrain', 'Hummer EV'],
  lincoln: ['Corsair', 'Nautilus', 'Aviator', 'Navigator'],
  byd: ['Atto 3', 'Dolphin', 'Han', 'Seal', 'Tang', 'Seal U', 'Sealion 7'],
  mg: ['MG3', 'MG4', 'MG5', 'ZS', 'ZS EV', 'HS', 'Marvel R', 'Cyberster'],
  nio: ['ET5', 'ET7', 'EL6', 'EL7', 'ES8'],
  'lynk-co': ['01', '02', '03', '05', '09'],
  polestar: ['Polestar 2', 'Polestar 3', 'Polestar 4'],
  rivian: ['R1T', 'R1S'],
  lucid: ['Air', 'Gravity'],
};

// Helper: case-insensitive search across brand names + ids.
export function searchBrands(query: string): CarBrand[] {
  const q = query.trim().toLowerCase();
  if (!q) return CAR_BRANDS;
  return CAR_BRANDS.filter((b) => b.name.toLowerCase().includes(q) || b.id.includes(q));
}

// Helper: search models for a brand. brand can be either id or name (best effort).
export function searchModels(brand: string, query: string): string[] {
  const id = brand.trim().toLowerCase();
  const exact = CAR_MODELS[id];
  // fallback: lookup by name match
  const list = exact ?? CAR_MODELS[CAR_BRANDS.find((b) => b.name.toLowerCase() === id)?.id ?? ''] ?? [];
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((m) => m.toLowerCase().includes(q));
}

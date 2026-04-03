const fs = require('node:fs')
const path = require('node:path')

const provinces = require('china-division/dist/provinces.json')
const cities = require('china-division/dist/cities.json')
const areas = require('china-division/dist/areas.json')

const provinceMap = new Map(provinces.map((p) => [p.code, p.name]))
const directCityProvinceCodes = new Set(['11', '12', '31', '50'])

const dedup = new Map()

for (const item of cities) {
  const provinceName = provinceMap.get(item.provinceCode)
  if (!provinceName) continue

  let cityName = item.name
  if (directCityProvinceCodes.has(item.provinceCode)) {
    cityName = provinceName
  } else {
    if (item.name === '市辖区' || item.name === '县' || item.name.includes('省直辖')) {
      continue
    }
  }

  if (!cityName.endsWith('市')) {
    continue
  }

  const key = `${provinceName}-${cityName}`
  if (!dedup.has(key)) {
    dedup.set(key, {
      code: item.code,
      name: cityName,
      admin1: provinceName,
    })
  }
}

const list = Array.from(dedup.values()).sort((a, b) => a.code.localeCompare(b.code))

const output = `export type LocalCity = {\n  code: string\n  name: string\n  admin1: string\n}\n\nexport const LOCAL_CITY_DATA: LocalCity[] = ${JSON.stringify(list, null, 2)}\n`

const outputPath = path.join(process.cwd(), 'src', 'data', 'cities.generated.ts')
fs.writeFileSync(outputPath, output, 'utf8')

const cityByCode = new Map(list.map((c) => [c.code, c]))
const districts = areas
  .filter((item) => cityByCode.has(item.cityCode))
  .map((item) => ({
    code: item.code,
    name: item.name,
    cityCode: item.cityCode,
    provinceCode: item.provinceCode,
  }))

const provinceNodes = []
for (const province of provinces) {
  const provinceCities = list.filter((c) => c.code.startsWith(province.code))
  if (provinceCities.length === 0) continue

  provinceNodes.push({
    code: province.code,
    name: province.name,
    cities: provinceCities.map((city) => ({
      code: city.code,
      name: city.name,
      districts: districts
        .filter((d) => d.cityCode === city.code)
        .map((d) => ({ code: d.code, name: d.name })),
    })),
  })
}

const cascadeOutput = `export type DistrictNode = {\n  code: string\n  name: string\n}\n\nexport type CityNode = {\n  code: string\n  name: string\n  districts: DistrictNode[]\n}\n\nexport type ProvinceNode = {\n  code: string\n  name: string\n  cities: CityNode[]\n}\n\nexport const CASCADE_DATA: ProvinceNode[] = ${JSON.stringify(provinceNodes, null, 2)}\n`

const cascadePath = path.join(process.cwd(), 'src', 'data', 'china-cascade.generated.ts')
fs.writeFileSync(cascadePath, cascadeOutput, 'utf8')

console.log(`Generated ${list.length} prefecture-level cities -> ${outputPath}`)
console.log(`Generated ${provinceNodes.length} provinces cascade -> ${cascadePath}`)

export const readyFood = {
  id: 118098,
  xml_id: 118098,
  name: "Паста&nbsp;&quot;Карбонара&quot;",
  price: {
    current: 260.4,
    currency: "RUB",
    old: 320,
    discount_percent: 18.6,
    discount_info: "Скидка по карте лояльности по 11.10",
  },
  rating: { average: 4.6, count: 100 },
  weight: { value: 0.3, unit: "кг" },
  url: "https://vkusvill.ru/goods/pasta-karbonara-118098/",
  category: [
    { id: 59969, name: "Вторые блюда с мясом" },
    { id: 50367, name: "Вторые блюда" },
    { id: 50361, name: "Готовая еда" },
  ],
};

export const readyFoodLowDiscount = {
  id: 2,
  xml_id: 200,
  name: "Суп",
  price: {
    current: 200,
    old: 210,
    discount_percent: 5,
    discount_info: "по 12.10",
  },
  rating: { average: 4.2 },
  weight: "300 г",
  url: "https://vkusvill.ru/goods/sup-2/",
  category: [{ id: 50361, name: "Готовая еда" }],
};

export const notReadyFood = {
  id: 3,
  xml_id: 300,
  name: "Молоко",
  price: { current: 90, old: 100, discount_percent: 10, discount_info: "по 11.10" },
  url: "https://vkusvill.ru/goods/moloko/",
  category: [{ id: 20, name: "Молоко" }],
};

export const hostileName = {
  id: 4,
  xml_id: 400,
  name: '<!channel> <@U1> <https://evil.example|подмена>',
  price: { current: 150, old: 180, discount_percent: 17, discount_info: "по 11.10" },
  url: "https://evil.example/goods/1",
  category: [{ id: 50361, name: "Готовая еда" }],
};

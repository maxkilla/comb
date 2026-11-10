"""Shopping cart totals. Prices are integer cents."""
from dataclasses import dataclass

TAX_RATE_BPS = 825  # basis points: 8.25%
FREE_SHIPPING_MIN = 5000
SHIPPING_FLAT = 599


@dataclass(frozen=True)
class Item:
    sku: str
    price: int
    qty: int = 1

    def __post_init__(self):
        if self.price < 0:
            raise ValueError(f"negative price for {self.sku}")
        if self.qty < 1:
            raise ValueError(f"qty must be >= 1 for {self.sku}")

    @property
    def line_total(self) -> int:
        return self.price * self.qty


def subtotal(items: list[Item]) -> int:
    return sum(i.line_total for i in items)


def shipping(sub: int) -> int:
    return 0 if sub >= FREE_SHIPPING_MIN or sub == 0 else SHIPPING_FLAT


def tax(sub: int) -> int:
    return (sub * TAX_RATE_BPS + 5000) // 10000


def total(items: list[Item]) -> int:
    sub = subtotal(items)
    return sub + shipping(sub) + tax(sub)


if __name__ == "__main__":
    demo = [Item("pen", 150, 4), Item("book", 1899)]
    assert total(demo) == 2499 + 599 + 206
    print(total(demo))

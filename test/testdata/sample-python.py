"""
Sample Python file for integration testing
Tests hierarchical extraction and Python-specific features
"""

from dataclasses import dataclass
from typing import List, Optional
from abc import ABC, abstractmethod


@dataclass
class Product:
    """Product data model"""
    id: str
    name: str
    price: float
    category: str


class BaseRepository(ABC):
    """Abstract base repository"""

    @abstractmethod
    def find_by_id(self, id: str):
        """Find item by ID"""
        pass

    @abstractmethod
    def save(self, item):
        """Save item to storage"""
        pass


class ProductRepository(BaseRepository):
    """Repository for managing products"""

    def __init__(self, db_connection):
        self._db = db_connection
        self._cache: dict = {}

    def find_by_id(self, id: str) -> Optional[Product]:
        """Find product by ID with caching"""
        if id in self._cache:
            return self._cache[id]

        result = self._db.query(f"SELECT * FROM products WHERE id = ?", id)
        if result:
            product = Product(**result)
            self._cache[id] = product
            return product
        return None

    def save(self, product: Product) -> bool:
        """Save product to database"""
        try:
            self._db.execute(
                "INSERT INTO products VALUES (?, ?, ?, ?)",
                product.id, product.name, product.price, product.category
            )
            self._cache[product.id] = product
            return True
        except Exception as e:
            print(f"Error saving product: {e}")
            return False

    def find_by_category(self, category: str) -> List[Product]:
        """Find all products in a category"""
        results = self._db.query(
            "SELECT * FROM products WHERE category = ?",
            category
        )
        return [Product(**r) for r in results]

    def _invalidate_cache(self, id: str) -> None:
        """Private method to invalidate cache entry"""
        if id in self._cache:
            del self._cache[id]


async def calculate_discount(price: float, discount_percent: float) -> float:
    """Calculate discounted price"""
    if discount_percent < 0 or discount_percent > 100:
        raise ValueError("Discount must be between 0 and 100")
    return price * (1 - discount_percent / 100)


def _internal_helper(data: dict) -> str:
    """Internal helper function (not exported)"""
    return str(data)

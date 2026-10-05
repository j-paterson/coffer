"""normalize_receipt_items: a txn itemized from a receipt must carry exactly
the receipt's lines, and those lines must sum to the money that moved."""
from __future__ import annotations

from finance_pipeline.receipt_items import normalize_receipt_items


def _email(conn, email_id: str, txn_id: int) -> None:
    conn.execute(
        "INSERT INTO emails (id, received_at, from_addr, subject, raw_path, "
        "extraction_status, match_status, transaction_v2_id) "
        "VALUES (?, '2025-05-01T12:00:00', 'x@y.com', 's', 'raw/x.eml', "
        "'extracted', 'strict', ?)",
        (email_id, txn_id),
    )


def _item(conn, email_id, txn_id, line_no, name, unit_price=None,
          line_total=None, quantity=None, category=None, subcategory=None,
          raw=None):
    conn.execute(
        "INSERT INTO transaction_items (email_id, transaction_v2_id, line_no, "
        "name, quantity, unit_price, line_total, category, subcategory, raw) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (email_id, txn_id, line_no, name, quantity, unit_price, line_total,
         category, subcategory, raw),
    )


def _items(conn, txn_id):
    return [
        (r["email_id"], r["name"], r["line_total"], r["category"])
        for r in conn.execute(
            "SELECT email_id, name, line_total, category FROM transaction_items "
            "WHERE transaction_v2_id = ? ORDER BY email_id IS NULL, line_no",
            (txn_id,),
        )
    ]


def _spend(seed_txn, amount, **kw):
    return seed_txn(
        date="2025-05-05", description="NORTHWIND CONTRACTORS",
        postings=[("live:chk", -amount), ("equity:unknown-counterparty", amount)],
        **kw,
    )


def test_even_split_is_replaced_by_each_lines_price(conn, seed_txn):
    tid = _spend(seed_txn, 3673.81)
    _email(conn, "em", tid)
    for n, (name, price) in enumerate(
        [("Electrical", 2650.00), ("Railing", 393.81), ("Trim", 630.00)], 1
    ):
        _item(conn, "em", tid, n, name, unit_price=price, line_total=-1224.60)

    stats = normalize_receipt_items(conn)

    assert stats.txns_fixed == 1
    assert [i[2] for i in _items(conn, tid)] == [-2650.00, -393.81, -630.00]


def test_placeholder_item_is_dropped_and_its_category_inherited(conn, seed_txn):
    tid = _spend(seed_txn, 21.27, item_category="Software")
    _email(conn, "em", tid)
    # Seat pack: quantity is part of the product, the price is the pack price
    # and the positive sign is the extractor's, not the ledger's.
    _item(conn, "em", tid, 1, "Teams pack for 10 users", unit_price=19.95,
          quantity=10, line_total=19.95)

    normalize_receipt_items(conn)

    # Placeholder gone; the single receipt line absorbs tax and takes its category.
    assert _items(conn, tid) == [("em", "Teams pack for 10 users", -21.27, "Software")]


def test_unpriced_line_gets_the_unexplained_remainder(conn, seed_txn):
    tid = _spend(seed_txn, 6733.60)
    _email(conn, "em", tid)
    _item(conn, "em", tid, 1, "Floor glue", unit_price=1245.23)
    _item(conn, "em", tid, 2, "Framing", unit_price=3680.00)
    _item(conn, "em", tid, 3, "Relocate light fixture")  # extractor lost its price
    _item(conn, "em", tid, 4, "Metal edges", unit_price=298.96)
    _item(conn, "em", tid, 5, "Stair nose", unit_price=934.41)
    _item(conn, "em", tid, 6, "Engineer visit", unit_price=425.00)

    normalize_receipt_items(conn)

    totals = [i[2] for i in _items(conn, tid)]
    assert totals == [-1245.23, -3680.00, -150.00, -298.96, -934.41, -425.00]


def test_legacy_split_amount_on_an_unpriced_line_is_not_trusted(conn, seed_txn):
    tid = _spend(seed_txn, 300.00)
    _email(conn, "em", tid)
    # The receipt priced only the first line; a legacy pass then stamped the
    # even split onto both. The extraction in `raw` is what the receipt said.
    _item(conn, "em", tid, 1, "Tile", unit_price=200.00, line_total=-150.00,
          raw='{"name": "Tile", "unit_price": "$200.00", "line_total": ""}')
    _item(conn, "em", tid, 2, "Grout", line_total=-150.00,
          raw='{"name": "Grout", "unitity_price": "$100.00", "line_total": ""}')

    normalize_receipt_items(conn)

    assert [i[2] for i in _items(conn, tid)] == [-200.00, -100.00]


def test_line_total_only_receipts_keep_their_proportions(conn, seed_txn):
    tid = _spend(seed_txn, 30.00)
    _email(conn, "em", tid)
    _item(conn, "em", tid, 1, "Book", line_total=20.00,
          raw='{"name": "Book", "unit_price": "", "line_total": "$20.00"}')
    _item(conn, "em", tid, 2, "Pen", line_total=10.00,
          raw='{"name": "Pen", "unit_price": "", "line_total": "$10.00"}')

    normalize_receipt_items(conn)
    normalize_receipt_items(conn)

    assert [i[2] for i in _items(conn, tid)] == [-20.00, -10.00]


def test_fees_and_tax_are_spread_so_lines_sum_to_the_charge(conn, seed_txn):
    tid = _spend(seed_txn, 100.00)
    _email(conn, "em", tid)
    _item(conn, "em", tid, 1, "A", unit_price=33.00, line_total=33.00)
    _item(conn, "em", tid, 2, "B", unit_price=33.00, line_total=33.00)
    _item(conn, "em", tid, 3, "C", unit_price=33.00, line_total=33.00)

    normalize_receipt_items(conn)

    totals = [i[2] for i in _items(conn, tid)]
    assert round(sum(totals), 2) == -100.00
    assert sorted(totals) == [-33.34, -33.33, -33.33]


def test_refund_keeps_positive_sign(conn, seed_txn):
    tid = seed_txn(
        date="2025-05-05", description="REFUND",
        postings=[("live:chk", 40.00), ("equity:unknown-counterparty", -40.00)],
    )
    _email(conn, "em", tid)
    _item(conn, "em", tid, 1, "Returned lamp", unit_price=40.00)

    normalize_receipt_items(conn)

    assert _items(conn, tid) == [("em", "Returned lamp", 40.00, None)]


def test_clean_txns_are_left_alone_and_rerun_is_a_noop(conn, seed_txn):
    plain = _spend(seed_txn, 12.00, item_category="Dining")
    tid = _spend(seed_txn, 50.00)
    _email(conn, "em", tid)
    _item(conn, "em", tid, 1, "Thing", unit_price=50.00, line_total=-50.00)
    conn.execute("DELETE FROM transaction_items WHERE transaction_v2_id = ? "
                 "AND email_id IS NULL", (tid,))

    assert normalize_receipt_items(conn).txns_fixed == 0
    assert _items(conn, plain) == [(None, "NORTHWIND CONTRACTORS", -12.00, "Dining")]


def test_dry_run_writes_nothing(conn, seed_txn):
    tid = _spend(seed_txn, 10.00)
    _email(conn, "em", tid)
    _item(conn, "em", tid, 1, "Thing", unit_price=10.00, line_total=10.00)
    before = _items(conn, tid)

    stats = normalize_receipt_items(conn, dry_run=True)

    assert stats.txns_fixed == 1
    assert _items(conn, tid) == before


def test_discount_lines_stay_negative(conn, seed_txn):
    tid = _spend(seed_txn, 12.00)
    _email(conn, "em", tid)
    _item(conn, "em", tid, 1, "Shirt", raw='{"unit_price": "$10.00", "line_total": "$10.00"}', unit_price=10.00)
    _item(conn, "em", tid, 2, "Socks", raw='{"unit_price": "$5.00", "line_total": "$5.00"}', unit_price=5.00)
    _item(conn, "em", tid, 3, "Coupon", raw='{"unit_price": "", "line_total": "-$3.00"}')

    normalize_receipt_items(conn)

    assert [i[2] for i in _items(conn, tid)] == [-10.00, -5.00, 3.00]


def test_receipt_line_total_beats_unit_price_times_quantity(conn, seed_txn):
    tid = _spend(seed_txn, 17.00)
    _email(conn, "em", tid)
    # 3 for $12 deal: the receipt's line total already has the discount.
    _item(conn, "em", tid, 1, "Soap x3", unit_price=5.00, quantity=3,
          raw='{"unit_price": "$5.00", "quantity": "3", "line_total": "$12.00"}')
    _item(conn, "em", tid, 2, "Brush", unit_price=5.00,
          raw='{"unit_price": "$5.00", "line_total": "$5.00"}')

    normalize_receipt_items(conn)

    assert [i[2] for i in _items(conn, tid)] == [-12.00, -5.00]


def test_users_category_on_the_txn_overrides_automatic_line_categories(conn, seed_txn):
    tid = _spend(seed_txn, 30.00, item_category="Business")
    conn.execute("UPDATE transaction_items SET category_source = 'user' WHERE transaction_v2_id = ?", (tid,))
    _email(conn, "em", tid)
    _item(conn, "em", tid, 1, "Coffee beans", unit_price=30.00, category="Groceries")

    normalize_receipt_items(conn)

    assert _items(conn, tid) == [
        ("em", "Coffee beans", -30.00, "Business"),
        (None, "NORTHWIND CONTRACTORS", 0.0, "Business"),  # kept, zeroed
    ]
    assert normalize_receipt_items(conn).txns_fixed == 0

    # The receipt goes away: the user's category is still there, with the amount.
    conn.execute("DELETE FROM emails WHERE id = 'em'")
    normalize_receipt_items(conn)
    assert _items(conn, tid) == [(None, "NORTHWIND CONTRACTORS", -30.00, "Business")]


def test_txn_whose_receipt_went_away_gets_its_placeholder_back(conn, seed_txn):
    tid = _spend(seed_txn, 25.00)
    _email(conn, "em", tid)
    _item(conn, "em", tid, 1, "Lamp", unit_price=25.00)
    normalize_receipt_items(conn)
    assert [i[0] for i in _items(conn, tid)] == ["em"]

    conn.execute("DELETE FROM emails WHERE id = 'em'")  # cascades to its lines
    stats = normalize_receipt_items(conn)

    assert stats.placeholders_restored == 1
    assert _items(conn, tid) == [(None, "NORTHWIND CONTRACTORS", -25.00, None)]


def test_re_extraction_dedupe_judges_the_kept_receipt_by_what_it_said(conn, seed_txn):
    from finance_pipeline.emails.extract import _write_extraction
    from finance_pipeline.emails.interfaces import ExtractedReceipt

    tid = _spend(seed_txn, 30.00)
    _email(conn, "old", tid)
    _email(conn, "new", tid)
    # The kept receipt priced only one of its two lines; normalization has
    # since filled both line_totals in.
    _item(conn, "old", tid, 1, "Book", raw='{"name": "Book", "line_total": "$20.00"}')
    _item(conn, "old", tid, 2, "Pen", raw='{"name": "Pen", "line_total": ""}')
    normalize_receipt_items(conn)

    receipt = ExtractedReceipt(
        merchant="Northwind Books", date="2025-05-05", currency="USD", subtotal=None,
        tax=None, total=30.00, payment_method="", order_id="",
        items=[{"name": "Book", "line_total": "$20.00"}, {"name": "Pen", "line_total": "$10.00"}],
    )
    assert _write_extraction(conn, "new", receipt, "{}") == 2
    assert {i[0] for i in _items(conn, tid)} == {"new"}

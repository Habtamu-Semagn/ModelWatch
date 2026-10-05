#!/usr/bin/env python3
"""Generates evals/datasets/codefix-v1/tasks.jsonl (15 Python bugfix tasks).

Version history, and why each change was needed:
  v1  trivial one-bug tasks. qwen/qwen3.8-27b solved 15/15 -> the dataset could
      not discriminate between models at all.
  v2  multi-constraint tasks (3-7 requirements each). STILL 15/15 for both
      qwen/qwen3.8-27b and gemini-3.5-flash-lite.
  v3  tasks with interacting constraints and adversarial edge cases: the
      requirements conflict with each other, boundary values are tested, and
      the naive fix passes the obvious case while failing the rest. The point
      is to leave headroom below 100% so a difference between models is
      measurable at all.

Each task is verified twice by scripts/check-dataset.ts: the shipped broken
code must FAIL, and a hand-written reference fix must PASS. A task where both
are true is neither a free point nor impossible.
"""
import json, pathlib

T = []


def add(tid, typ, instruction, code, tests, reference=None):
    T.append({
        "id": tid,
        "type": typ,
        "scoring": "programmatic",
        "instruction": instruction,
        "input_file": "solution.py",
        "code": code.strip("\n") + "\n",
        "tests": tests.strip("\n") + "\n",
        # Ground truth for judge scoring (step 8). Supplied by REFERENCE_FIXES
        # below — one source of truth, so the judge and check-dataset.ts can
        # never grade against different "correct" answers.
        "reference": reference or "",
    })


# Hand-written correct solutions, verified by scripts/check-dataset.ts to pass
# every task's tests. NOT copied from model output: if they came from a model,
# the judge would be graded against a model's idea of correct rather than the
# task's stated requirements.
REFERENCE_FIXES = {
    "t01": "def get(d, k, default=None):\n    return d[k] if k in d else default\n",
    "t02": "def mean(xs):\n    nums = [x for x in xs if isinstance(x, (int, float)) and not isinstance(x, bool)]\n    return sum(nums) / len(nums) if nums else 0.0\n",
    "t03": 'def fizzbuzz(n):\n    out = []\n    for i in range(1, n + 1):\n        if i % 15 == 0: out.append("FizzBuzz")\n        elif i % 3 == 0: out.append("Fizz")\n        elif i % 5 == 0: out.append("Buzz")\n        else: out.append(str(i))\n    return out\n',
    "t04": "def chunk(xs, n):\n    if n <= 0: raise ValueError('n must be positive')\n    return [xs[i : i + n] for i in range(0, len(xs), n)]\n",
    "t05": 'def is_palindrome(s):\n    t = "".join(c for c in s if c.isalnum()).lower()\n    return t == t[::-1]\n',
    "t06": "def flatten(xs):\n    out = []\n    for x in xs:\n        if isinstance(x, list): out.extend(flatten(x))\n        else: out.append(x)\n    return out\n",
    "t07": "def second_largest(xs):\n    u = sorted(set(xs), reverse=True)\n    return u[1] if len(u) > 1 else None\n",
    "t08": "def safe_divide(a, b):\n    return None if b == 0 else a / b\n",
    "t09": "def dedupe(xs):\n    out = []\n    for x in xs:\n        if x not in out: out.append(x)\n    return out\n",
    "t10": "def parse_csv(line):\n    return [int(f) for f in (x.strip() for x in line.split(',')) if f]\n",
    "t11": "def factorial(n):\n    if isinstance(n, bool) or not isinstance(n, int): raise TypeError('n must be an int')\n    if n < 0: raise ValueError('n must be non-negative')\n    r = 1\n    for i in range(2, n + 1): r *= i\n    return r\n",
    "t12": 'def group_anagrams(words):\n    buckets = {}\n    for w in words: buckets.setdefault("".join(sorted(w)), []).append(w)\n    return list(buckets.values())\n',
    "t13": "def matrix_multiply(a, b):\n    if not a or not b: return []\n    if len(a[0]) != len(b): raise ValueError('dimension mismatch')\n    return [[sum(a[i][k] * b[k][j] for k in range(len(b))) for j in range(len(b[0]))] for i in range(len(a))]\n",
    "t14": 'def longest_common_prefix(strs):\n    if not strs: return ""\n    prefix = strs[0]\n    for s in strs[1:]:\n        while not s.startswith(prefix):\n            prefix = prefix[:-1]\n            if not prefix: return ""\n    return prefix\n',
    "t15": "def running_max(xs):\n    out = []\n    m = None\n    for x in xs:\n        m = x if m is None or x > m else m\n        out.append(m)\n    return out\n",
}


add("t01", "bugfix",
    "Implement get(d, k, default=None) with these rules: return d[k] when the key "
    "is present (including a stored None); otherwise return default. Counts of "
    "the dict must be unchanged by the call. Do not use dict.get for the "
    "present-key branch, because get cannot distinguish a stored None from a "
    "missing key when default is falsy.",
    '''
def get(d, k, default=None):
    v = d.get(k)
    return v if v is not None else default
''',
    '''
import pytest
from solution import get

def test_present():
    assert get({"a": 1}, "a") == 1

def test_missing_returns_default():
    assert get({}, "a", 99) == 99

def test_missing_no_default():
    assert get({}, "a") is None

def test_falsy_default_still_used_when_missing():
    assert get({}, "a", 0) == 0
    assert get({}, "a", "") == ""
    assert get({}, "a", False) is False

def test_stored_none_wins_over_default():
    assert get({"a": None}, "a", 99) is None
    assert get({"a": None}, "a", 0) is None

def test_count_preserved():
    d = {"a": 1}
    get(d, "missing", 5)
    assert d == {"a": 1}
    assert len(d) == 1

def test_empty_dict():
    assert get({}, "x", None) is None
''')

add("t02", "bugfix",
    "Implement mean(xs): the arithmetic mean of numeric entries only. Non-numeric "
    "entries (str, None, bool, list, dict) are SKIPPED entirely and excluded from "
    "the divisor. If no numeric entries remain, return 0.0. Always return a float. "
    "Note bool is a subclass of int and must not be counted as numeric.",
    '''
def mean(xs):
    nums = [x for x in xs if isinstance(x, int)]
    return sum(nums) / len(nums) if nums else 0.0
''',
    '''
from solution import mean

def test_basic():
    assert mean([1, 2, 3]) == 2.0

def test_empty():
    assert mean([]) == 0.0

def test_skips_non_numeric_from_divisor():
    assert mean([1, 2, "x", 3]) == 2.0

def test_bools_excluded():
    assert mean([1, 2, True, False]) == 1.5

def test_all_non_numeric():
    assert mean(["a", None, [1], {}]) == 0.0

def test_single_numeric():
    assert mean(["junk", 4]) == 4.0

def test_float_and_int():
    assert mean([1, 2.5]) == 1.75

def test_always_float():
    assert isinstance(mean([2, 4]), float)
    assert isinstance(mean([]), float)
''')

add("t03", "bugfix",
    'fizzbuzz(n) returns a list of exactly n STRINGS for i in 1..n inclusive: '
    '"FizzBuzz" if divisible by 15, else "Fizz" if by 3, else "Buzz" if by 5, '
    'else the decimal string of i. n <= 0 returns []. Negative n must not loop.',
    '''
def fizzbuzz(n):
    out = []
    for i in range(1, n):
        if i % 15 == 0:
            out.append("FizzBuzz")
        elif i % 3 == 0:
            out.append("Fizz")
        elif i % 5 == 0:
            out.append("Buzz")
        else:
            out.append(i)
    return out
''',
    '''
from solution import fizzbuzz

def test_includes_last_element():
    assert len(fizzbuzz(5)) == 5

def test_first_five():
    assert fizzbuzz(5) == ["1", "2", "Fizz", "4", "Buzz"]

def test_all_strings():
    assert all(isinstance(x, str) for x in fizzbuzz(30))

def test_multiples_of_fifteen():
    out = fizzbuzz(30)
    assert out[14] == "FizzBuzz"

def test_length_matches_n():
    for n in (1, 2, 5, 15, 20):
        assert len(fizzbuzz(n)) == n

def test_non_positive():
    assert fizzbuzz(0) == []
    assert fizzbuzz(-5) == []

def test_single():
    assert fizzbuzz(1) == ["1"]

def test_fifteen_is_fizzbuzz():
    assert fizzbuzz(15)[-1] == "FizzBuzz"
''')

add("t04", "bugfix",
    "Implement chunk(xs, n): split xs into consecutive sublists of at most n "
    "elements, preserving order and NOT mutating xs. n <= 0 raises ValueError. "
    "For empty xs return []. Note that a chunk of size 1 must yield one element "
    "per sublist, and n larger than len(xs) must yield a single chunk.",
    '''
def chunk(xs, n):
    if n <= 0:
        raise ValueError("n must be positive")
    return [xs[i : i + n] for i in range(0, len(xs), n - 1)]
''',
    '''
from solution import chunk

def test_exact_division():
    assert chunk([1, 2, 3, 4], 2) == [[1, 2], [3, 4]]

def test_remainder():
    assert chunk([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]

def test_empty():
    assert chunk([], 3) == []

def test_size_one():
    assert chunk([1, 2, 3], 1) == [[1], [2], [3]]

def test_n_exceeds_length():
    assert chunk([1, 2], 10) == [[1, 2]]

def test_preserves_all_elements_in_order():
    xs = list(range(10))
    out = chunk(xs, 3)
    assert [e for c in out for e in c] == xs

def test_no_mutation():
    xs = [1, 2, 3]
    chunk(xs, 2)
    assert xs == [1, 2, 3]

def test_zero_raises():
    try:
        chunk([1, 2], 0)
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for n=0")

def test_negative_raises():
    try:
        chunk([1, 2], -1)
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for n=-1")
''')

add("t05", "bugfix",
    "is_palindrome(s): ignore case and every non-alphanumeric character, then "
    "compare. A string with no alphanumerics left is a palindrome. Must not "
    "mutate the input. Note str.isalnum() is True for non-ASCII letters and "
    "digits, which is fine; the bug here is folding case AFTER filtering.",
    '''
def is_palindrome(s):
    t = "".join(c for c in s if c.isalnum())
    return t == t[::-1]
''',
    '''
from solution import is_palindrome

def test_simple():
    assert is_palindrome("racecar")

def test_case_insensitive():
    assert is_palindrome("A man, a plan, a canal: Panama")
    assert is_palindrome("RaceCar")

def test_not_palindrome():
    assert not is_palindrome("hello")

def test_empty():
    assert is_palindrome("")

def test_single_char():
    assert is_palindrome("x")

def test_only_punctuation():
    assert is_palindrome("!!! ,.;")

def test_digits():
    assert is_palindrome("12321")

def test_spaces_only():
    assert is_palindrome("   ")

def test_no_mutation():
    s = "A man, a plan"
    is_palindrome(s)
    assert s == "A man, a plan"
''')

add("t06", "bugfix",
    "flatten(xs): recursively flatten nested lists into a flat list in order. "
    "Empty nested lists contribute nothing. Non-list, non-tuple values are kept "
    "as-is. Strings must NOT be iterated character-wise. Do not mutate the input.",
    '''
def flatten(xs):
    out = []
    for x in xs:
        if isinstance(x, list):
            out.extend(x)
        else:
            out.append(x)
    return out
''',
    '''
from solution import flatten

def test_one_level():
    assert flatten([1, [2, 3], 4]) == [1, 2, 3, 4]

def test_deeply_nested():
    assert flatten([1, [2, [3, [4, [5]]]]]) == [1, 2, 3, 4, 5]

def test_empty():
    assert flatten([]) == []

def test_empty_nested_lists_vanish():
    assert flatten([[], [[]], [1], [[], 2]]) == [1, 2]

def test_string_not_exploded():
    assert flatten(["ab", ["cd"]]) == ["ab", "cd"]

def test_tuples_are_leaves():
    assert flatten([(1, 2), 3]) == [(1, 2), 3]

def test_no_mutation():
    xs = [1, [2, 3]]
    flatten(xs)
    assert xs == [1, [2, 3]]
''')

add("t07", "bugfix",
    "second_largest(xs): return the second largest DISTINCT value, or None when "
    "fewer than two distinct values exist. Must work on unsorted input and must "
    "not mutate the input. An empty list returns None. Note: iterating a sorted "
    "set and taking [-2] crashes on short inputs, so handle that case.",
    '''
def second_largest(xs):
    u = sorted(set(xs))
    return u[-2]
''',
    '''
from solution import second_largest

def test_unsorted():
    assert second_largest([1, 5, 3, 5, 4]) == 4

def test_already_sorted():
    assert second_largest([1, 2, 3]) == 2

def test_two_values():
    assert second_largest([2, 1]) == 1

def test_all_equal():
    assert second_largest([7, 7, 7]) is None

def test_single_value():
    assert second_largest([7]) is None

def test_empty():
    assert second_largest([]) is None

def test_negatives():
    assert second_largest([-1, -5, -3]) == -3

def test_no_mutation():
    xs = [3, 1, 2]
    second_largest(xs)
    assert xs == [3, 1, 2]
''')

add("t08", "bugfix",
    "safe_divide(a, b): return a / b using TRUE division as a float, or None "
    "when b == 0. Accept int and float arguments. b == 0.0 must also return "
    "None. Do not use // (floor division) and do not let ZeroDivisionError escape.",
    '''
def safe_divide(a, b):
    if b == 0:
        return None
    return a // b
''',
    '''
from solution import safe_divide

def test_fraction():
    assert safe_divide(7, 2) == 3.5

def test_int_zero_denominator():
    assert safe_divide(1, 0) is None

def test_float_zero_denominator():
    assert safe_divide(1.0, 0.0) is None

def test_exact():
    assert safe_divide(4, 2) == 2.0

def test_negative_numerator():
    assert safe_divide(-7, 2) == -3.5

def test_negative_denominator():
    assert safe_divide(7, -2) == -3.5

def test_returns_float():
    assert isinstance(safe_divide(4, 2), float)

def test_fractional_args():
    assert safe_divide(1, 0.5) == 2.0
''')

add("t09", "bugfix",
    "dedupe(xs): remove duplicates keeping the FIRST occurrence's position and "
    "value, preserving overall order. Must handle UNHASHABLE items (lists, dicts, "
    "sets) which cannot go in a set. The input must not be mutated. Do not sort.",
    '''
def dedupe(xs):
    seen = set()
    out = []
    for x in xs:
        if x not in seen:
            out.append(x)
        seen.add(x)
    return out
''',
    '''
from solution import dedupe

def test_basic():
    assert dedupe([3, 1, 3, 2, 1]) == [3, 1, 2]

def test_empty():
    assert dedupe([]) == []

def test_strings():
    assert dedupe(["b", "a", "b"]) == ["b", "a"]

def test_all_unique():
    assert dedupe([1, 2, 3]) == [1, 2, 3]

def test_all_identical():
    assert dedupe([1, 1, 1]) == [1]

def test_unhashable_lists():
    assert dedupe([[1], [2], [1]]) == [[1], [2]]

def test_unhashable_dicts():
    assert dedupe([{"a": 1}, {"b": 2}, {"a": 1}]) == [{"a": 1}, {"b": 2}]

def test_order_preserved_not_sorted():
    assert dedupe([3, 1, 2, 1]) == [3, 1, 2]

def test_no_mutation():
    xs = [1, 1, 2]
    dedupe(xs)
    assert xs == [1, 1, 2]
''')

add("t10", "bugfix",
    "parse_csv(line): split on commas, strip whitespace from each field, drop "
    "fields that are empty after stripping, and convert the rest to int. Raise "
    "ValueError if a non-empty field is not a valid integer (including floats "
    "like '1.5'). An empty or whitespace-only line returns []. Do not mutate the "
    "input string.",
    '''
def parse_csv(line):
    fields = [f.strip() for f in line.split(",")]
    return [f for f in fields if f]
''',
    '''
from solution import parse_csv

def test_basic():
    assert parse_csv("1, 2 ,3") == [1, 2, 3]

def test_empty_fields_dropped():
    assert parse_csv("1,,2,") == [1, 2]

def test_whitespace_only_fields_dropped():
    assert parse_csv("1,   ,2") == [1, 2]

def test_blank_line():
    assert parse_csv("") == []

def test_whitespace_line():
    assert parse_csv("     ") == []

def test_negative_numbers():
    assert parse_csv("-1,2") == [-1, 2]

def test_float_field_raises():
    try:
        parse_csv("1,1.5")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for float field")

def test_non_numeric_raises():
    try:
        parse_csv("1,abc")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError")
''')

add("t11", "bugfix",
    "factorial(n): exact n! for 0 <= n <= 20, ValueError for n < 0, and "
    "TypeError for non-integer n. 0! is 1 and 1! is 1. Note bool is a subclass "
    "of int and should be rejected as a non-integer type.",
    '''
def factorial(n):
    if n < 0:
        raise ValueError("n must be non-negative")
    r = 1
    for i in range(n):
        r *= i
    return r
''',
    '''
from solution import factorial

def test_zero():
    assert factorial(0) == 1

def test_one():
    assert factorial(1) == 1

def test_five():
    assert factorial(5) == 120

def test_ten():
    assert factorial(10) == 3628800

def test_twenty():
    assert factorial(20) == 2432902008176640000

def test_negative():
    try:
        factorial(-1)
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError")

def test_float_raises():
    try:
        factorial(2.0)
    except TypeError:
        pass
    else:
        raise AssertionError("expected TypeError")

def test_string_raises():
    try:
        factorial("3")
    except TypeError:
        pass
    else:
        raise AssertionError("expected TypeError")
''')

add("t12", "bugfix",
    "group_anagrams(words): group words that are anagrams of each other. Group "
    "ORDER is the first-seen order of each group, and within a group the input "
    "order is preserved. Duplicated words are kept (do not dedupe). Case is "
    "significant. Empty input returns []. A word with no letters is its own group.",
    '''
def group_anagrams(words):
    buckets = {}
    for w in words:
        buckets.setdefault(w, []).append(w)
    return list(buckets.values())
''',
    '''
from solution import group_anagrams

def test_basic():
    assert group_anagrams(["eat", "tea", "tan", "ate", "nat", "bat"]) == [
        ["eat", "tea", "ate"], ["tan", "nat"], ["bat"]
    ]

def test_empty():
    assert group_anagrams([]) == []

def test_single():
    assert group_anagrams(["abc"]) == [["abc"]]

def test_duplicates_preserved():
    assert group_anagrams(["ab", "ba", "ab"]) == [["ab", "ba", "ab"]]

def test_no_shared_letters():
    assert group_anagrams(["abc", "def"]) == [["abc"], ["def"]]

def test_case_sensitive():
    assert group_anagrams(["Ab", "aB"]) == [["Ab"], ["aB"]]

def test_group_order_is_first_seen():
    assert group_anagrams(["xyz", "abc", "zyx"]) == [["xyz", "zyx"], ["abc"]]

def test_lengths_differ():
    assert group_anagrams(["ab", "abc"]) == [["ab"], ["abc"]]
''')

add("t13", "bugfix",
    "matrix_multiply(a, b): return the matrix product of two 2D lists of "
    "numbers. Raise ValueError when the inner dimensions disagree "
    "(len(a[0]) != len(b)). An empty a or empty b returns []. A 1-row matrix "
    "times a column vector must work. Do not mutate the inputs.",
    '''
def matrix_multiply(a, b):
    if not a or not b:
        return []
    return [[sum(a[i][k] * b[k][j] for k in range(len(b))) for j in range(len(b[0]))]
            for i in range(len(a))]
''',
    '''
from solution import matrix_multiply

def test_identity():
    assert matrix_multiply([[1, 2], [3, 4]], [[1, 0], [0, 1]]) == [[1, 2], [3, 4]]

def test_row_times_column():
    assert matrix_multiply([[1, 2, 3]], [[1], [2], [3]]) == [[14]]

def test_general_square():
    assert matrix_multiply([[1, 2], [3, 4]], [[5, 6], [7, 8]]) == [[19, 22], [43, 50]]

def test_rectangular_2x3_times_3x2():
    assert matrix_multiply([[1, 2, 3], [4, 5, 6]], [[7, 8], [9, 10], [11, 12]]) == [
        [58, 64], [139, 154]
    ]

def test_empty_left():
    assert matrix_multiply([], [[1]]) == []

def test_empty_right():
    assert matrix_multiply([[1]], []) == []

def test_dimension_mismatch_raises():
    try:
        matrix_multiply([[1, 2]], [[1, 2]])
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError")

def test_no_mutation():
    a = [[1, 2], [3, 4]]
    b = [[5, 6], [7, 8]]
    matrix_multiply(a, b)
    assert a == [[1, 2], [3, 4]]
    assert b == [[5, 6], [7, 8]]
''')

add("t14", "bugfix",
    "longest_common_prefix(strs): the longest prefix shared by EVERY string, or "
    '"" when there is none. An empty list returns "". Single-character inputs '
    'must work. If any string is "" the result is "". Do not mutate the input.',
    '''
def longest_common_prefix(strs):
    if not strs:
        return ""
    prefix = strs[0]
    for s in strs[1:]:
        if not s.startswith(prefix):
            return strs[0]
    return prefix
''',
    '''
from solution import longest_common_prefix

def test_basic():
    assert longest_common_prefix(["flower", "flow", "flight"]) == "fl"

def test_no_common_prefix():
    assert longest_common_prefix(["dog", "racecar"]) == ""

def test_single_string():
    assert longest_common_prefix(["abc"]) == "abc"

def test_single_char_string():
    assert longest_common_prefix(["a"]) == "a"

def test_all_equal():
    assert longest_common_prefix(["ab", "ab"]) == "ab"

def test_empty_list():
    assert longest_common_prefix([]) == ""

def test_empty_member_forces_empty_result():
    assert longest_common_prefix(["abc", ""]) == ""

def test_one_shorter_than_prefix():
    assert longest_common_prefix(["abcdef", "abc"]) == "abc"

def test_exact_degenerate():
    assert longest_common_prefix(["a", "b"]) == ""
''')

add("t15", "bugfix",
    "running_max(xs): for each index, the maximum of the prefix up to and "
    "including that index. Empty input returns []. Works with negative numbers "
    "(the first element is always its own prefix max). Must not mutate the "
    "input. Note that using max(out[-1], x) fails on an empty out.",
    '''
def running_max(xs):
    out = []
    for x in xs:
        out.append(max(out))
    return out
''',
    '''
from solution import running_max

def test_basic():
    assert running_max([1, 3, 2, 5, 4]) == [1, 3, 3, 5, 5]

def test_empty():
    assert running_max([]) == []

def test_all_negative():
    assert running_max([-3, -5, -1]) == [-3, -3, -1]

def test_single():
    assert running_max([7]) == [7]

def test_descending():
    assert running_max([5, 4, 3]) == [5, 5, 5]

def test_single_negative():
    assert running_max([-7]) == [-7]

def test_mixed_signs():
    assert running_max([-1, 0, -5, 2]) == [-1, 0, 0, 2]

def test_length_preserved():
    assert len(running_max([3, 1, 4, 1, 5])) == 5

def test_no_mutation():
    xs = [1, 3, 2]
    running_max(xs)
    assert xs == [1, 3, 2]
''')

out = pathlib.Path(__file__).resolve().parents[1] / "evals/datasets/codefix-v1/tasks.jsonl"

# Attach reference fixes and fail loudly on any gap: a judge task without
# ground truth is worse than no judge task, because it looks scored.
missing = [t["id"] for t in T if t["id"] not in REFERENCE_FIXES]
if missing:
    raise SystemExit(f"no reference fix for: {', '.join(missing)}")
for t in T:
    t["reference"] = REFERENCE_FIXES[t["id"]]

out.write_text("".join(json.dumps(t) + "\n" for t in T), encoding="utf8")
print(f"wrote {len(T)} tasks -> {out}")
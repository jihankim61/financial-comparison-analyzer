# -*- coding: utf-8 -*-
import sys
import os
import win32com.client as win32

path = os.path.abspath(sys.argv[1])

excel = win32.gencache.EnsureDispatch("Excel.Application")
excel.Visible = False
excel.DisplayAlerts = False
try:
    wb = excel.Workbooks.Open(path)
    excel.CalculateFullRebuild()
    wb.Save()

    errors = []
    ERROR_TOKENS = ("#REF!", "#VALUE!", "#DIV/0!", "#NAME?", "#N/A", "#NULL!", "#NUM!")
    for ws in wb.Worksheets:
        used = ws.UsedRange
        rows = used.Rows.Count
        cols = used.Columns.Count
        values = used.Value
        if rows == 1 and cols == 1:
            values = ((values,),)
        elif rows == 1:
            values = (values,)
        elif cols == 1:
            values = tuple((v,) for v in values)
        for i in range(rows):
            for j in range(cols):
                v = values[i][j]
                if isinstance(v, str) and v in ERROR_TOKENS:
                    errors.append(f"{ws.Name}!{used.Cells(i+1, j+1).Address} = {v}")

    wb.Close(SaveChanges=True)
    if errors:
        print("ERRORS_FOUND:")
        for e in errors:
            print(" ", e)
    else:
        print("NO_ERRORS")
finally:
    excel.Quit()

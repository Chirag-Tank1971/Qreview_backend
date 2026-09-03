import express, { Response } from 'express';
import { getDbCollection } from '../db.js';
import { authenticateToken, requireRoles, recordAuditLog, AuthenticatedRequest } from '../auth.js';
import { Kra, KraTemplate, KraItem } from '../../src/types.js';

export const kraRouter = express.Router();

// All KRA routes require authentication
kraRouter.use(authenticateToken);

// ==========================================
// 1. KRA LIBRARY MASTER
// ==========================================

/**
 * GET /api/kras
 * Supports query params: departmentId, search
 */
kraRouter.get('/kras', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { departmentId, search } = req.query;
    const kraCol = getDbCollection('kras');
    let allKras: Kra[] = await (await kraCol.find({})).toArray();

    if (departmentId) {
      allKras = allKras.filter((k) => !k.departmentId || k.departmentId === departmentId);
    }

    if (search) {
      const q = String(search).toLowerCase();
      allKras = allKras.filter(
        (k) =>
          k.title.toLowerCase().includes(q) ||
          k.description.toLowerCase().includes(q) ||
          k.category.toLowerCase().includes(q) ||
          (k.departmentName && k.departmentName.toLowerCase().includes(q))
      );
    }

    res.json(allKras);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch KRAs.' });
  }
});

/**
 * POST /api/kras
 * Admin/HR/HOD only
 */
kraRouter.post('/kras', requireRoles('SUPER_ADMIN', 'HR', 'HOD'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, description, category, metricType, targetUnit, departmentId } = req.body;

    if (!title || !category || !metricType) {
      return res.status(400).json({ error: 'Title, category, and metricType are required.' });
    }

    const kraCol = getDbCollection('kras');
    const deptCol = getDbCollection('departments');

    let departmentName: string | undefined;
    if (departmentId) {
      const dept = await deptCol.findOne({ id: departmentId });
      if (dept) departmentName = dept.name;
    }

    const newKra: Kra = {
      id: `kra_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      title: title.trim(),
      description: (description || '').trim(),
      category: category.trim(),
      metricType,
      targetUnit: targetUnit ? targetUnit.trim() : undefined,
      departmentId: departmentId || undefined,
      departmentName,
      active: true,
      createdAt: new Date().toISOString(),
    };

    await kraCol.insertOne(newKra);

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'KRA_MASTER',
        'CREATE_KRA',
        newKra.id,
        '',
        newKra.title,
        `Created standard KRA "${newKra.title}" (${newKra.category})`
      );
    }

    res.status(201).json(newKra);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to create KRA.' });
  }
});

/**
 * PUT /api/kras/:id
 */
kraRouter.put('/kras/:id', requireRoles('SUPER_ADMIN', 'HR', 'HOD'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description, category, metricType, targetUnit, departmentId, active } = req.body;

    const kraCol = getDbCollection('kras');
    const deptCol = getDbCollection('departments');
    const kra = await kraCol.findOne({ id });
    if (!kra) {
      return res.status(404).json({ error: 'KRA not found.' });
    }

    const updateData: Partial<Kra> = {};
    if (title !== undefined) updateData.title = title.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (category !== undefined) updateData.category = category.trim();
    if (metricType !== undefined) updateData.metricType = metricType;
    if (targetUnit !== undefined) updateData.targetUnit = targetUnit ? targetUnit.trim() : undefined;
    if (active !== undefined) updateData.active = Boolean(active);

    if (departmentId !== undefined) {
      updateData.departmentId = departmentId || undefined;
      if (departmentId) {
        const dept = await deptCol.findOne({ id: departmentId });
        updateData.departmentName = dept?.name;
      } else {
        updateData.departmentName = undefined;
      }
    }

    await kraCol.updateOne({ id }, { $set: updateData });
    const updated = await kraCol.findOne({ id });

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'KRA_MASTER',
        'UPDATE_KRA',
        id,
        JSON.stringify(kra),
        JSON.stringify(updated),
        `Updated KRA "${kra.title}"`
      );
    }

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update KRA.' });
  }
});

// ==========================================
// 2. KRA TEMPLATES (100% Total Weight Enforced)
// ==========================================

/**
 * GET /api/kra-templates
 * Supports filters: departmentId, designationId, search
 */
kraRouter.get('/kra-templates', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { departmentId, designationId, search } = req.query;
    const templateCol = getDbCollection('kraTemplates');
    let allTemplates: KraTemplate[] = await (await templateCol.find({})).toArray();

    if (departmentId) {
      allTemplates = allTemplates.filter((t) => t.departmentId === departmentId);
    }

    if (designationId) {
      allTemplates = allTemplates.filter((t) => t.designationId === designationId);
    }

    if (search) {
      const q = String(search).toLowerCase();
      allTemplates = allTemplates.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.departmentName.toLowerCase().includes(q) ||
          t.designationName.toLowerCase().includes(q)
      );
    }

    res.json(allTemplates);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch KRA templates.' });
  }
});

/**
 * GET /api/kra-templates/:id
 */
kraRouter.get('/kra-templates/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const templateCol = getDbCollection('kraTemplates');
    const template = await templateCol.findOne({ id });
    if (!template) {
      return res.status(404).json({ error: 'KRA template not found.' });
    }
    res.json(template);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch KRA template details.' });
  }
});

/**
 * POST /api/kra-templates
 * Strictly validates that the sum of item weights = 100%
 */
kraRouter.post('/kra-templates', requireRoles('SUPER_ADMIN', 'HR', 'HOD'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, departmentId, designationId, items, description } = req.body;

    if (!title || !departmentId || !designationId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'Required fields missing: title, departmentId, designationId, and at least 1 KRA item.',
      });
    }

    // Strict 100% weight validation
    const totalWeight = items.reduce((sum: number, item: KraItem) => sum + (Number(item.weight) || 0), 0);
    if (Math.round(totalWeight) !== 100) {
      return res.status(400).json({
        error: `Total KRA weightage must equal exactly 100%. Current total: ${totalWeight}%`,
      });
    }

    const deptCol = getDbCollection('departments');
    const desCol = getDbCollection('designations');
    const templateCol = getDbCollection('kraTemplates');

    const dept = await deptCol.findOne({ id: departmentId });
    const des = await desCol.findOne({ id: designationId });

    const sanitizedItems: KraItem[] = items.map((it: any, idx: number) => ({
      id: it.id || `item_${Date.now()}_${idx}`,
      kraId: it.kraId || undefined,
      title: (it.title || '').trim(),
      description: (it.description || '').trim(),
      weight: Number(it.weight) || 0,
      target: (it.target || '').trim(),
      measurementCriteria: (it.measurementCriteria || '').trim(),
    }));

    const newTemplate: KraTemplate = {
      id: `tmpl_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      title: title.trim(),
      departmentId,
      departmentName: dept?.name || 'Department',
      designationId,
      designationName: des?.name || 'Designation',
      items: sanitizedItems,
      totalWeight: 100,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await templateCol.insertOne(newTemplate);

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'KRA_TEMPLATE_MASTER',
        'CREATE_TEMPLATE',
        newTemplate.id,
        '',
        newTemplate.title,
        `Created KRA Template "${newTemplate.title}" for ${newTemplate.designationName} (${newTemplate.departmentName}) with ${newTemplate.items.length} items totaling 100%`
      );
    }

    res.status(201).json(newTemplate);
  } catch (error: any) {
    console.error('Error creating KRA template:', error);
    res.status(500).json({ error: 'Failed to create KRA template.' });
  }
});

/**
 * PUT /api/kra-templates/:id
 */
kraRouter.put('/kra-templates/:id', requireRoles('SUPER_ADMIN', 'HR', 'HOD'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { title, departmentId, designationId, items, active } = req.body;

    const templateCol = getDbCollection('kraTemplates');
    const deptCol = getDbCollection('departments');
    const desCol = getDbCollection('designations');

    const template = await templateCol.findOne({ id });
    if (!template) {
      return res.status(404).json({ error: 'KRA template not found.' });
    }

    const updateData: Partial<KraTemplate> = {
      updatedAt: new Date().toISOString(),
    };

    if (title !== undefined) updateData.title = title.trim();
    if (active !== undefined) updateData.active = Boolean(active);

    if (departmentId !== undefined) {
      updateData.departmentId = departmentId;
      const dept = await deptCol.findOne({ id: departmentId });
      if (dept) updateData.departmentName = dept.name;
    }

    if (designationId !== undefined) {
      updateData.designationId = designationId;
      const des = await desCol.findOne({ id: designationId });
      if (des) updateData.designationName = des.name;
    }

    if (items !== undefined) {
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'KRA template must contain at least 1 item.' });
      }

      const totalWeight = items.reduce((sum: number, it: KraItem) => sum + (Number(it.weight) || 0), 0);
      if (Math.round(totalWeight) !== 100) {
        return res.status(400).json({
          error: `Total KRA weightage must equal exactly 100%. Current total: ${totalWeight}%`,
        });
      }

      updateData.items = items.map((it: any, idx: number) => ({
        id: it.id || `item_${Date.now()}_${idx}`,
        kraId: it.kraId || undefined,
        title: (it.title || '').trim(),
        description: (it.description || '').trim(),
        weight: Number(it.weight) || 0,
        target: (it.target || '').trim(),
        measurementCriteria: (it.measurementCriteria || '').trim(),
      }));
      updateData.totalWeight = 100;
    }

    await templateCol.updateOne({ id }, { $set: updateData });
    const updated = await templateCol.findOne({ id });

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'KRA_TEMPLATE_MASTER',
        'UPDATE_TEMPLATE',
        id,
        JSON.stringify(template),
        JSON.stringify(updated),
        `Updated KRA Template "${template.title}"`
      );
    }

    res.json(updated);
  } catch (error: any) {
    console.error('Error updating KRA template:', error);
    res.status(500).json({ error: 'Failed to update KRA template.' });
  }
});

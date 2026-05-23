import { Controller, Get, Res, Param } from '@nestjs/common';
import { Response } from 'express';
import { join } from 'path';
import * as fs from 'fs';

@Controller('admin-panel')
export class AdminPanelController {
  // Path from /app/backend/dist/modules/admin-panel to /app/admin/dist
  private adminDistPath = join(__dirname, '..', '..', '..', '..', 'admin', 'dist');

  @Get()
  serveIndex(@Res() res: Response) {
    const indexPath = join(this.adminDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    return res.status(404).send('Admin panel not found');
  }

  @Get('assets/:file')
  serveAsset(@Param('file') file: string, @Res() res: Response) {
    const filePath = join(this.adminDistPath, 'assets', file);
    if (fs.existsSync(filePath)) {
      // Set correct content type
      if (file.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript');
      } else if (file.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css');
      }
      return res.sendFile(filePath);
    }
    return res.status(404).send('File not found');
  }

  @Get('*')
  serveAll(@Res() res: Response) {
    // SPA fallback - return index.html for all routes
    const indexPath = join(this.adminDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    return res.status(404).send('Admin panel not found');
  }
}
